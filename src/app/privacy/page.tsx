export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12 text-gray-300">
      <h1 className="text-2xl font-bold text-white mb-2">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: March 1, 2026</p>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">1. Information We Collect</h2>
        <p className="text-sm leading-relaxed">
          When you claim a square on Daali Boards, we collect your name, email address, and phone number.
          Phone numbers are collected solely for the purpose of sending SMS notifications related to your
          participation in a squares game, including payment confirmations and winner notifications.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">2. SMS Notifications</h2>
        <p className="text-sm leading-relaxed mb-3">
          By checking the SMS opt-in box during the square claiming process, you consent to receive text
          messages from Daali Boards. These messages may include:
        </p>
        <ul className="text-sm leading-relaxed list-disc list-inside space-y-1 text-gray-400">
          <li>Payment confirmation when your square purchase is complete</li>
          <li>Winner notifications if your square wins a period</li>
        </ul>
        <p className="text-sm leading-relaxed mt-3">
          Message frequency varies per game. Message and data rates may apply. You can opt out at any
          time by replying <strong className="text-white">STOP</strong> to any message. For help, reply{" "}
          <strong className="text-white">HELP</strong>.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">3. How We Use Your Information</h2>
        <p className="text-sm leading-relaxed">
          We use your information only to operate the squares game you participate in. We do not sell,
          rent, or share your personal information with third parties for marketing purposes. Your phone
          number is never shared with other players or hosts beyond what is necessary to coordinate
          payouts.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">4. Data Retention</h2>
        <p className="text-sm leading-relaxed">
          Your information is retained for the duration of the game and a reasonable period afterward
          for record-keeping. You may request deletion of your data by contacting us at the email below.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">5. Third-Party Services</h2>
        <p className="text-sm leading-relaxed">
          We use Twilio to deliver SMS messages and Stripe to process payments. These services have their
          own privacy policies. We do not control how they handle data beyond what is required to deliver
          our service.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">6. Contact</h2>
        <p className="text-sm leading-relaxed">
          For questions about this policy or to request data deletion, contact us at{" "}
          <a href="mailto:support@daali.app" className="text-indigo-400 hover:text-indigo-300">
            support@daali.app
          </a>
          .
        </p>
      </section>
    </div>
  );
}
