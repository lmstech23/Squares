export type RsvpConfirmationData = {
  personName: string
  eventTitle: string
  when: string
  venue: string | null
  partySize: number
  manageUrl: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderRsvpConfirmation(d: RsvpConfirmationData) {
  const seats = `${d.partySize} ${d.partySize === 1 ? 'spot' : 'spots'}`
  const subject = `You're in — ${d.eventTitle}`

  const text = [
    `Hi ${d.personName},`,
    ``,
    `You're confirmed for ${d.eventTitle}.`,
    ``,
    `When:  ${d.when}`,
    ...(d.venue ? [`Where: ${d.venue}`] : []),
    `Spots: ${seats}`,
    ``,
    `Need to change or cancel? ${d.manageUrl}`,
    ``,
    `— Daali`,
  ].join('\n')

  const html = `<!doctype html><html><body style="margin:0;background:#07070c;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#0e0e16;border:1px solid #22222f;border-radius:14px;" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 30px;">
  <p style="margin:0 0 6px;color:#7f7f98;font-size:13px;">You&rsquo;re in</p>
  <h1 style="margin:0 0 20px;color:#edecf5;font-size:26px;font-weight:400;line-height:1.2;">${esc(d.eventTitle)}</h1>
  <p style="margin:0 0 4px;color:#b6b5ca;font-size:15px;">${esc(d.when)}</p>
  ${d.venue ? `<p style="margin:0 0 4px;color:#7f7f98;font-size:14px;">${esc(d.venue)}</p>` : ''}
  <p style="margin:0 0 24px;color:#7f7f98;font-size:14px;">${esc(seats)} reserved for ${esc(d.personName)}</p>
  <a href="${esc(d.manageUrl)}" style="display:inline-block;background:#a9a2f5;color:#0a0918;font-weight:600;font-size:15px;text-decoration:none;padding:12px 22px;border-radius:8px;">Manage your RSVP</a>
  <p style="margin:22px 0 0;color:#57576d;font-size:12.5px;">If you didn&rsquo;t RSVP, you can ignore this email.</p>
</td></tr></table>
</td></tr></table></body></html>`

  return { subject, text, html }
}
