export default function TermsPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12 text-gray-300">
      <h1 className="text-2xl font-bold text-white mb-2">Terms and Conditions</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: March 1, 2026</p>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">1. Acceptance of Terms</h2>
        <p className="text-sm leading-relaxed">
          By using Daali Boards, you agree to these Terms and Conditions. If you do not agree, do not
          use the platform. These terms apply to all users, including hosts who create boards and players
          who claim squares.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">2. Description of Service</h2>
        <p className="text-sm leading-relaxed">
          Daali Boards is a platform that allows hosts to create and manage sports squares games and
          allows players to claim squares and participate in those games. Daali Boards facilitates
          payment collection and winner determination but does not organize, sponsor, or guarantee any
          game outcome or payout.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">3. Host Responsibilities</h2>
        <p className="text-sm leading-relaxed">
          Hosts are solely responsible for ensuring their squares games comply with all applicable local,
          state, and federal laws, including laws related to gambling and contests of chance. Daali Boards
          makes no representations about the legality of squares games in any jurisdiction. Hosts are
          responsible for paying out winners in a timely manner and for accurately entering game scores.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">4. Player Responsibilities</h2>
        <p className="text-sm leading-relaxed">
          Players are responsible for ensuring their participation in squares games is permitted under
          applicable law. By claiming a square, players agree to provide accurate contact and payment
          information. Payments for squares are final once confirmed.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">5. Payments and Refunds</h2>
        <p className="text-sm leading-relaxed">
          Payments are processed through Stripe. Once a square is confirmed as paid, refunds are not
          guaranteed and are at the discretion of the host. Daali Boards is not responsible for disputes
          between hosts and players regarding payouts or refunds.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">6. SMS Communications</h2>
        <p className="text-sm leading-relaxed">
          By opting in to SMS notifications, you consent to receive text messages from Daali Boards
          related to your game participation. You may opt out at any time by replying STOP. Message and
          data rates may apply.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">7. Limitation of Liability</h2>
        <p className="text-sm leading-relaxed">
          Daali Boards is provided as-is. We are not liable for any damages arising from your use of
          the platform, including but not limited to lost winnings, failed payments, or disputes between
          hosts and players. Our total liability to any user shall not exceed the amount paid to us in
          the 30 days preceding the claim.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">8. Changes to Terms</h2>
        <p className="text-sm leading-relaxed">
          We reserve the right to update these terms at any time. Continued use of the platform after
          changes constitutes acceptance of the new terms.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">9. Contact</h2>
        <p className="text-sm leading-relaxed">
          For questions about these terms, contact us at{" "}
          <a href="mailto:support@daali.app" className="text-indigo-400 hover:text-indigo-300">
            support@daali.app
          </a>
          .
        </p>
      </section>
    </div>
  );
}
