import type { EmailProvider } from '../types'
import { consoleProvider } from './console'
import { resendProvider } from './resend'

/** The one place that decides who sends mail. */
export function emailProvider(): EmailProvider {
  return process.env.RESEND_API_KEY ? resendProvider : consoleProvider
}
