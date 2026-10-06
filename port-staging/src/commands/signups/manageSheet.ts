import { prisma } from '@/lib/prisma'
import { runCommand } from '@/lib/commands/runCommand'
import { requireOrganizer, requireOwnership } from '@/lib/commands/authorize'
import { fail, ok, type Command } from '@/lib/commands/types'
import type { SlotType } from '@/domain/signups'

async function ownedEvent(eventId: string) {
  return prisma.event.findUnique({ where: { id: eventId }, select: { id: true, organizerUserId: true } })
}

export type AddSlotInput = {
  eventId: string
  slotType: SlotType
  name: string
  capacity: number
  startsAt?: Date | null
  endsAt?: Date | null
  unitLabel?: string | null
  notes?: string | null
}
export type AddSlotResult = { slotId: string; sheetId: string }

export const addSlot: Command<AddSlotInput, AddSlotResult> = async (input, ctx) => {
  const denied = requireOrganizer<AddSlotResult>(ctx.actor)
  if (denied) return denied

  const event = await ownedEvent(input.eventId)
  if (!event) return fail('NOT_FOUND', 'That event no longer exists.')
  const notYours = requireOwnership<AddSlotResult>(ctx.actor, event)
  if (notYours) return notYours

  if (!input.name?.trim()) return fail('VALIDATION_FAILED', 'Give it a name.', [{ field: 'name', message: 'Required.' }])
  if (!Number.isInteger(input.capacity) || input.capacity < 1) {
    return fail('VALIDATION_FAILED', 'How many are needed?', [{ field: 'capacity', message: 'At least 1.' }])
  }
  if (input.slotType === 'SHIFT' && input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
    return fail('VALIDATION_FAILED', 'The shift ends before it starts.', [{ field: 'endsAt', message: 'Must be after the start.' }])
  }

  return runCommand({
    name: 'addSlot',
    input,
    ctx,
    eventId: event.id,
    execute: async (tx) => {
      // The sheet is created lazily on the first slot. An organizer never has to
      // "create a sheet" as a separate act.
      const sheet = await tx.signupSheet.upsert({
        where: { eventId: event.id },
        create: { eventId: event.id },
        update: {},
        select: { id: true },
      })

      const last = await tx.signupSlot.findFirst({
        where: { sheetId: sheet.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true },
      })

      const slot = await tx.signupSlot.create({
        data: {
          sheetId: sheet.id,
          slotType: input.slotType,
          name: input.name.trim(),
          capacity: input.capacity,
          // A shift carries a time window; an item carries a unit. Neither
          // borrows the other's field.
          startsAt: input.slotType === 'SHIFT' ? input.startsAt ?? null : null,
          endsAt: input.slotType === 'SHIFT' ? input.endsAt ?? null : null,
          unitLabel: input.slotType === 'ITEM' ? input.unitLabel?.trim() || null : null,
          notes: input.notes?.trim() || null,
          sortOrder: (last?.sortOrder ?? 0) + 10,
        },
        select: { id: true },
      })

      return ok({ slotId: slot.id, sheetId: sheet.id })
    },
  })
}

export type SetSheetOpenInput = { eventId: string; isOpen: boolean }
export type SetSheetOpenResult = { isOpen: boolean }

export const setSheetOpen: Command<SetSheetOpenInput, SetSheetOpenResult> = async (input, ctx) => {
  const denied = requireOrganizer<SetSheetOpenResult>(ctx.actor)
  if (denied) return denied

  const event = await ownedEvent(input.eventId)
  if (!event) return fail('NOT_FOUND', 'That event no longer exists.')
  const notYours = requireOwnership<SetSheetOpenResult>(ctx.actor, event)
  if (notYours) return notYours

  return runCommand({
    name: 'setSheetOpen',
    input,
    ctx,
    eventId: event.id,
    execute: async (tx) => {
      await tx.signupSheet.upsert({
        where: { eventId: event.id },
        create: { eventId: event.id, isOpen: input.isOpen },
        update: { isOpen: input.isOpen },
      })
      return ok({ isOpen: input.isOpen })
    },
  })
}

export type RemoveSlotInput = { slotId: string }
export type RemoveSlotResult = { slotId: string; removedClaims: number }

export const removeSlot: Command<RemoveSlotInput, RemoveSlotResult> = async (input, ctx) => {
  const denied = requireOrganizer<RemoveSlotResult>(ctx.actor)
  if (denied) return denied

  const slot = await prisma.signupSlot.findUnique({
    where: { id: input.slotId },
    select: {
      id: true, _count: { select: { signups: true } },
      sheet: { select: { event: { select: { id: true, organizerUserId: true } } } },
    },
  })
  if (!slot) return fail('NOT_FOUND', 'That slot no longer exists.')
  const notYours = requireOwnership<RemoveSlotResult>(ctx.actor, slot.sheet.event)
  if (notYours) return notYours

  return runCommand({
    name: 'removeSlot',
    input,
    ctx,
    eventId: slot.sheet.event.id,
    execute: async (tx) => {
      await tx.signupSlot.delete({ where: { id: slot.id } })
      return ok({ slotId: slot.id, removedClaims: slot._count.signups })
    },
  })
}
