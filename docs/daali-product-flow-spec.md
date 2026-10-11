<!--
IMPORTED DOCUMENT: Daali Product Flow Spec (Oct 10, 2026)
Source: Claude Docs export, received as "daali-product-flow-spec.md"
Export date: Oct 10, 2026
sha256 of the received file: 80f3e9b97dacfc0f31e76fd307fd31f582d40b022e13945e64f144d529bf5768
Everything below this comment is that file, byte for byte; it has not been edited.
Per CLAUDE.md ("If a spec is not in this repository, it is not authoritative"),
this repository copy is now the authoritative version.
-->

# Daali Product Flow Spec

Oct 4, 2026 · @Daaliyah

## Purpose and authority

This spec turns the 27 approved Figma frames (Daali.pdf, exported Oct 4, 2026) into screens, actions, transitions and commands, so engineering builds without assumptions. Where Figma is silent, this spec says so and lists the gap; it does not fill it.

Authority map (approved Oct 4). The repo is implementation evidence, not product authority. If two governing specs genuinely conflict, stop and surface the conflict; never resolve it by following what the code does today.

| Area | Governing source |
| --- | --- |
| Visual presentation and canonical copy | Approved Figma frames |
| Authentication and onboarding through `/home` | Daali Auth + Onboarding Spec |
| Product behavior after `/home` | Daali Product Flow Spec (this document) |
| New Event domain invariants | Phase 0A–0D Technical Plan, Event Path Gate Independence Spec, phase-specific approved Event specs |
| Legacy Board / Game Day | SYSTEM-FLOW and its existing companion specs |
| Standalone Fundraiser | Its dedicated architecture spec, once approved |
| Standalone Raffle | Its dedicated architecture spec, once approved |
| Organizer-chosen public addresses | Vanity Path Addendum (Rev 4, once approved) |
| Payments, platform fee and payouts on new paths | Daali Payment Direction Spec. Planning only until separately approved |

Implementation naming: product and domain language stay clean (Event, `createEvent`). New persistence models use a `Daali` prefix (`DaaliEvent`, later `DaaliFundraiser`, `DaaliRaffle`) with their own table names, so they cannot collide with legacy Board or fundraiser models. The prefix never appears in the UI.

Companions: the [Daali Auth + Onboarding Spec](https://claude.ai/code/artifact/8abb2d19-547b-495f-8689-a07ffb3040c8) owns everything up to `/home`; `daali-phase-0a-0d-plan.md` and `event-path-gate-independence.md` own the Event domain and its rules.

Out of scope: migrating Hampton or any live fundraiser, the standalone Fundraiser root, the Raffle backend design, payment processing and payouts (planning only, in the Payment Direction Spec), and organizer-owned domains. Each is named where it blocks a screen.

## Decisions

Every open question is now decided (product review, Oct 4). There are no working assumptions left; each decision below is binding and recorded in the section it affects.

| Topic | Decision |
| --- | --- |
| UI system boards | Both are canonical. "1.0 extension" adds to "1.0"; no conflicts. |
| "Create \_\_\_ manually" vs "\_\_\_ setup" frames | Sequential steps of one flow. |
| Two Event management frames | One screen in three states: base and two insight panels. |
| Fundraiser creation (was O3) | Do not build the Figma flow on the legacy Board. It waits for the standalone Fundraiser root. |
| Hampton and live fundraisers (was O1, O2) | Hampton and every existing fundraiser write path stay untouched until their dedicated migration. The new public Fundraiser design applies only to Fundraiser-root records. |
| Raffle architecture (was O4) | Standalone, with an optional Event link. Entry issuance waits for the Raffle backend and legal/compliance rules. |
| Event step 2 Fundraiser and Raffle tools (O5) | Hidden until that organizer type can actually be created. No dead-end capability cards, no "Coming soon". Once available: create the Event, continue into that flow prefilled and linked; nothing fundraising-shaped is stored on Event \[R5\]. |
| Where an Event is published (was O6) | The same management workspace, in draft state, with "Publish event". Organizer-only. |
| Home recommendation vs "Your plan" (O7) | Two presentations of the same proposal, sharing one underlying proposal state. |
| Event timezone (O8) | Defaults to the organizer's browser timezone and is shown on Review so the organizer can verify it before creation. |
| Capacity (was O9) | An optional "Guest capacity" field appears under the RSVP card when RSVP is selected. Editable later in Edit event. |
| Raised amount and supporter count (was O10) | Organizer-confirmed contributions only. The model never estimates them. |
| Desktop vs mobile wording (O11) | Desktop wording is canonical ("Start a fundraiser"). |
| Mobile organizer-item cards (O12) | Keep View page and the AI shortcut, as secondary actions so the card stays compact. Mobile stays functionally complete. |
| Location | Two optional fields, Venue name and Address. No parsing of one field. |
| Fundraiser text | Two levels: Short description and Story. No third field. |
| Supporter quotes | Removed from MVP. |
| Every gap in the former "Needs design" table | Decided; recorded in the section it affects. |
| Public page address (Oct 10) | Organizers choose their own address, daali.app/\<address>, at publish in Slice 4. It stays in the browser's address bar for the whole visit; there is no redirect to /e/\[slug\]. Free. New Daali Events first, then standalone Fundraisers; legacy Boards are not touched. Organizer-owned domains are a separate capability, not Slice 4. Governed by the Vanity Path Addendum. |
| Payments (Oct 10) | Organizing stays free. Final pricing (Givebutter model): Events, RSVPs, volunteers and fundraiser creation are free. For integrated card donations and paid tickets, the organizer chooses per event or fundraiser: Option A, tips enabled — 0% platform fee, contributors may tip Daali any amount, Daali keeps tips, organizers are never charged a shortfall, and Daali covers processing contributors don't cover; or Option B, tips disabled — a 3% platform fee, no tip prompt, processing separate and covered by contributors where permitted or borne by the organizer. Direct Zelle, Cash App and Venmo payments carry no Daali fee. All payment behavior is planning only until separately approved and adds no step, field or card to Slices 1–5. Governed by the Payment Direction Spec. |
| Fundraiser duration, goal and recurring donations (Oct 10) | Approved Oct 10 (P-24): organizers may run ongoing fundraisers with no goal and no end date. Without a goal, the public page shows amount raised and supporter count with no progress bar. Recurring donations are planned for integrated payments only, with an optional tip whose future amount the contributor can change or stop (P-22); they need frames and are not part of the current slices. |

## Product model

Daali has three top-level organizer types: Event, Fundraiser and Raffle. Capabilities attach to one of them; Volunteers is a capability, never a type.

| Organizer type | Capabilities (Figma) | Backed today by | State |
| --- | --- | --- | --- |
| Event | RSVP, Volunteers (shifts), Items & supplies. Optional linked Fundraiser or Raffle. | Phase 0A–0C package: `Event`, `Registration`, sign-up slots (SHIFT and ITEM) | Built and tested; not in the production repo |
| Fundraiser | Payment methods (Venmo, Zelle, PayPal, Cash App), goal, story, cover image, optional deadline, organizer display name | Legacy fundraiser Board, read through `legacyFundraiserProvider` | Read model only. New creation waits for the standalone Fundraiser root |
| Raffle | Prize, entry price, entries per purchase, max entries per person, drawing date and time, free-entry instructions, optional linked Event | Nothing | Not built. Standalone, optional Event link |

Rules that hold for every type:

- AI and manual paths call the same commands and produce the same records. AI is never a separate backend path.
- A linked Fundraiser or Raffle is its own record with a link to the Event. Nothing fundraising-shaped is stored on `Event` \[R5\].
- The AI may say "volunteer project" because users do. It always resolves to Event + RSVP + Volunteers.
- Your Daali reads every type through `OrganizerItem[]` only, as the auth spec defines. New types add a provider; the home screen does not change.

## Journey map

The journey runs Get started → Setup → `/home` → AI or manual → Review → manage → public page. The Auth + Onboarding Spec owns everything before `/home`; this spec owns everything after.

&#91;embedded content: organizer journey · auth to public page\]

The AI path never writes on its own: approval prefills the manual steps, and Review is the single point where either path creates or publishes.

## Global rules

Every screen uses the UI system tokens and components below; no page carries its own styling.

### Navigation

- Organizer screens: "D Daali" wordmark left, optional breadcrumb context ("/ New event", "/ Guided setup", "/ Homecoming Tailgate"), organizer avatar, name and "Organizer" with a chevron on the right. No sidebar.
- Public pages: wordmark plus "Community pages" on the left, "Share page" text action on the right. No organizer identity.
- Organizer footer on home and public pages: "Organized with care by Daali."

Avatar menu, kept small: Organizer profile, Settings, Legacy Boards (entitled users only), Sign out. It is never primary navigation, and Legacy Boards never appears beside Event, Fundraiser and Raffle.

### UI system

| Token | Value |
| --- | --- |
| Colors | Canvas `#F4F0E9`, Surface `#FFFEFB`, Ink `#17212B`, Accent `#A84F35` |
| Type | Lora for headings, Inter for body and labels; uppercase accent section labels ("CREATE AN EVENT") |
| Spacing | 8 tight, 16 element, 24 group, 32 card, 48 region, 64 section |
| Radii | 8 small controls, 12 inputs, 18 cards, 24 feature panels |
| Layout | Desktop 1440 px page, 88 px gutters, 1264 px content; mobile 390 px, 24 px gutters |
| Controls | 48 px touch targets; Primary, Secondary, Text action, each with hover and visible focus |
| Status chips | Event / Fundraiser / Raffle (type), Live, Draft, Proposal only, AI proposal, Draft preview, Ready to review |

Components to build once: capability card (selected and unselected), organizer type card, organizer item card, AI input with suggestion chips, AI recommendation panel, AI insight panel, review panel, stepper, empty state, public-page section.

### AI presentation

- The AI input stays visible, optional and structured. Results render as panels and cards, never chat bubbles.
- Any proposal carries a "Proposal only" chip and the line "Nothing is created until you approve."
- Every manual step offers a quiet "Ask Daali" text action. Manual setup never requires AI.

## Your Daali (`/home`)

Every signed-in, set-up organizer lands here. It has three states: populated, empty, and showing a recommendation.

### Layout, top to bottom

1. Greeting: "Hi, {first name}." (accent, small) over "What are you organizing?" (Lora, display).
2. AI organizer card: "Tell Daali what you're planning." / "Describe what you need, and Daali will help organize the pieces." Input placeholder "I'm organizing…", primary "Plan with Daali". Chips: Family reunion, Fundraiser, Homecoming event, Volunteer project, Raffle. Helper: "Not sure what you need? Just describe it."
3. "Or choose what you want to organize" with three type cards:
   - Event: "Plan your gathering, manage RSVPs, and coordinate volunteers in one place." → "Create an event"
   - Fundraiser: "Raise money for a cause, team, school, organization, or community." → "Start a fundraiser"
   - Raffle: "Create a raffle, manage entries, and keep everything organized through the drawing." → "Create a raffle"
4. "Your organizing" / "Everything you're organizing, all in one place." with one item card per `OrganizerItem`, or the empty state.

### Organizer item card

| Item status | Meta line (example) | Left actions | Right AI shortcut |
| --- | --- | --- | --- |
| Fundraiser, Live | Updated recently | Manage, View page | Ask Daali what needs attention |
| Event, Live | 64 guests attending | Manage, View page | Summarize RSVPs |
| Raffle, Draft | Setup in progress | Continue setup | Help me finish setup |

An AI shortcut appears only when that insight is built for that type. If it is not built, the shortcut is absent. There is no "Coming soon" state anywhere.

### Empty state

Shown in place of the list when the organizer has no items: plus icon, "Nothing here yet. Your first Daali starts above." / "Describe your plan or choose a starting point — you'll always review the details first."

### Recommendation state

After "Plan with Daali" on desktop, the page stays in place:

- The input keeps the request text with an accent border.
- A "Here's what I recommend" panel appears below, with a "Proposal only" chip, the line "Daali will prepare these pieces together. Review the plan before anything is created.", one checked capability card per piece, and "Looks good" (primary), "Adjust" (secondary), and "Nothing is created until you approve."
- The type cards become "Or choose manually" with short copy: "Plan details, RSVPs, and volunteers." / "Raise money for a cause or community." / "Manage prizes, entries, and the drawing."

### Transitions

| Action | Goes to |
| --- | --- |
| Plan with Daali | Recommendation state (desktop) or recommendation screen (mobile) |
| Create an event / Start a fundraiser / Create a raffle | Step 1 of that manual flow |
| Manage | That item's management screen |
| View page | That item's public page, new tab |
| Continue setup | The first incomplete step of that item's flow, prefilled |
| AI shortcut | Management screen with that insight panel open |

### AI input behavior

- Tapping a suggestion chip fills the input and does not submit. "Homecoming event" becomes "I'm organizing a Homecoming event…", editable, so the organizer can add context before "Plan with Daali".
- "Plan with Daali" with an empty input does not submit. The page stays put and a short inline prompt asks them to describe what they are organizing. No default proposal is made up.

## AI path

The AI path produces a proposal, lets the organizer change it, and on approval hands a prefilled draft to the same Review screen the manual path uses. Nothing is written before approval.

### Screens

| Screen | Breadcrumb | Content | Actions |
| --- | --- | --- | --- |
| Recommendation | Home (desktop inline), or own screen on mobile | "Here's what I recommend", "Proposal only", checked capability cards with one-line purpose | Looks good, Adjust |
| Your plan | / Guided setup | Left: "PLAN WITH DAALI", "Let's shape the plan together.", "Your request" card quoting the input, "Daali prepares the structure. You choose what gets created and when it's published." Right: "Your plan", "Ready to review" chip, "Four connected pieces, ready for your approval.", checked capability cards | Build this, Change something |
| Adjust your plan | / Guided setup | "Current plan", "Proposal only", "Changes return to the recommendation for your approval.", capability cards each with Edit, "+ Add another capability", "Tell Daali what you want to change" input | Edit (per card), Add another capability, Update plan |

### Transitions

1. Plan with Daali → Recommendation.
2. Looks good / Build this → Event basics (step 1), prefilled with everything Daali extracted. Fields Daali could not extract stay empty and required.
3. Continue → Organizing tools (step 2), with the proposal's capabilities checked → Review → Create event. From here the paths are identical.
4. Adjust / Change something → Adjust your plan.
5. Update plan → Daali revises the proposal → back to the Recommendation or Your plan for approval. "Nothing changes until you approve."
6. Edit on a capability card → the card expands inline so the organizer can change what Daali proposed for that capability without leaving the plan. Changes update the proposal only; nothing is written.

### Convergence point

The home recommendation, "Your plan" and "Adjust your plan" all read and write one proposal state (O7). Both paths converge at Review. The Review screen shows every value, whoever filled it, and "Create event" is the only control that writes. The UI system's review panel states it: "Manual and AI paths converge before creation or publishing."

### What Daali may recommend

Only capabilities in the catalog: Event, RSVP, Volunteers, Items & supplies, Fundraiser, Raffle. A request outside the catalog gets the closest match plus a plain note of what is not supported. Daali never invents a capability.

The proposal is held in session until approval. On approval, commands run with actor `AGENT`, `onBehalfOfUserId` = the organizer and a `planExecutionId`, as the 0A–0D plan reserves. A persisted `PlanningSession` is Phase 1 work and not needed for this flow.

### When Daali cannot help

- **Cannot interpret the request:** Daali says plainly that it could not confidently structure the request and offers Event, Fundraiser and Raffle right there. The request stays in the input for revision. No aggressive guessing.
- **AI unavailable:** manual flows work fully. If the failure follows an AI action, a small non-blocking message offers the three manual paths. No full-page AI error.
- **Proposed shifts and items:** Daali may propose specific shifts or items. They stay proposal data until the organizer approves their creation, which happens after the draft Event exists.

## Manual Event flow

Three steps, breadcrumb "/ New event", section label "CREATE AN EVENT". The result is a draft Event; nothing is public until it is published.

The step 1 frame shows a two-step stepper (Event basics, Add organizing tools); steps 2 and 3 show three (adding Review). Build three steps everywhere.

### Step 1 — Event basics

Heading "Let's set up your event." / "Start with the basics. You can add RSVPs, volunteers, and more as you go."

| Field | Placeholder / default | Maps to |
| --- | --- | --- |
| Event name | e.g., Johnson Family Reunion | `title` (required) |
| Date | Select a date | date part of `startsAt` (required) |
| Start time | 10:00 AM | time part of `startsAt` |
| End time | 4:00 PM | `endsAt` |
| Venue name | optional | `venueName` |
| Address | optional | `venueAddress` |
| Description | Share what guests should know about this event… | `description` |
| Cover photo | optional | Event cover image (new field). Without one, the public page uses the standard Daali visual treatment |
| (none) | browser timezone | `timezone` (required; shown on Review, O8) |

Daali may prefill Venue name, Address or both only when it can extract them confidently.

Actions: "Back to Your Daali" (text), "Need help? Ask Daali" (text), "Continue" (primary). Continue validates required fields client-side; nothing is saved yet.

### Step 2 — Add organizing tools

Heading "What do you need for this event?" / "Choose the tools that fit your event. You can change these later." Card label "Choose one or more organizing tools."

| Tool | Card copy | Becomes |
| --- | --- | --- |
| RSVP | Keep track of who's coming and how many guests they're bringing. Capacity can be added if needed. | Registration enabled |
| Volunteers | Create shifts and coordinate people helping before, during, or after the event. | SHIFT slots |
| Items & supplies | Let people sign up to bring food, supplies, equipment, or other needed items. | ITEM slots |
| Fundraiser (Optional) | Accept contributions connected to this event. | Linked Fundraiser. Hidden until the Fundraiser root exists (O5) |
| Raffle | Add a raffle connected to this event. | Linked Raffle. Hidden until Raffle can be created (O5) |

Selecting RSVP reveals an optional **Guest capacity** field under the RSVP card. Daali prefills it when the request names a number ("a gala for 600 people"). It stays editable in Edit event, never below seats already taken.

Selecting Volunteers or Items & supplies enables the capability only. Shifts, items, times and quantities are configured after the draft exists, from Manage volunteers. Initial creation never asks for a volunteer sheet.

Actions: "Back", "✦ Not sure what you need? Ask Daali", "Continue". Selecting no tool is allowed: an Event with no tools is a plain event page. Until their types can be created, the Fundraiser and Raffle cards are not rendered at all.

### Step 3 — Review

Heading "Review your event" / "Here's what Daali will set up. You can change anything before publishing." Panel with "Draft preview" chip: title, EVENT DETAILS (Date & time with timezone, Location), ORGANIZING TOOLS (one line per tool with a summary, e.g. "Volunteers · Setup, welcome table, and cleanup shifts").

Actions: "Edit" (back to step 1, values kept) and "Create event" (primary). Footnote: "Your event is created as a draft. Nothing is public until you publish it."

Create event runs `createEvent` (status `DRAFT`) with one idempotency key per Review render, so a double tap replays rather than duplicates. It then goes to the Event management screen.

Create event creates no slots. Review's tool lines describe the capability ("Volunteers · Shifts you'll set up next"), not specific shifts, unless the organizer approved Daali-proposed shifts, which are created after the draft exists.

## Manual Fundraiser flow

Four steps, breadcrumb "/ New fundraiser", section label "CREATE A FUNDRAISER". Review publishes directly. This flow writes only to the standalone Fundraiser root and is blocked until that root exists. It is never built on the legacy Board.

### Step 1 — Fundraiser basics

Heading "Let's start your fundraiser." / "Tell us what you're raising money for." The left column shows a tip card instead of a stepper: "Start with the story" / "A clear goal and a short, personal description help your community understand how to support you."

| Field | Placeholder |
| --- | --- |
| Fundraiser name | e.g., Hampton Alumni Scholarship Fund |
| Fundraising goal (optional) | $ 5,000 |
| Short description | Tell supporters what you're raising money for and why it matters… |

An "Ask Daali to help write your fundraiser description" row marked "Optional" sits under the fields. Actions: "Back to Your Daali", "Continue".

### Step 2 — Payment methods

Heading "How do you want to collect contributions?" / "Choose the payment methods you want supporters to see."

| Method | Configured state | Unconfigured state |
| --- | --- | --- |
| Venmo | "Venmo details are ready to show supporters." / Connected | "Add the Venmo name or link…" / Add details |
| Zelle | "Zelle details are ready to show supporters." / Connected | same pattern |
| PayPal | same pattern | "Add the PayPal name or link supporters should use." / Add details |
| Cash App | same pattern | "Add the Cash App name or link supporters should use." / Add details |

"Add details" opens a small drawer for that method, storing the organizer's reusable handle or name and a link where the method has one. "Connected" means details are saved, not an OAuth or API connection. Footnote: "Supporters choose a method on your public page. You stay in control of the details shown." Actions: "Back", "✦ Ask Daali for help choosing payment methods", "Continue". At least one method is required to continue.

**Payment direction (Oct 10, planning only).** These direct methods stay. The Payment Direction Spec is evaluating integrated methods that confirm themselves (cards, and possibly Cash App Pay or Venmo checkout) and separates direct payments into Awaiting payment, Contributor reports payment and Payment verified; only verified payments count toward totals or anything payment-gated. Card donations through integrated checkout would follow the organizer's pricing choice: tips enabled (no platform fee, optional tip to Daali, processing guaranteed by Daali) or tips disabled (3% platform fee). Creating and managing the fundraiser stays free, and direct methods carry no Daali fee. Nothing here changes until that spec is approved.

### Step 3 — Public page

Heading "Make your fundraiser yours" / "Shape the story supporters will see on your public page."

Fields: Cover image or photo ("Choose a warm community photo"), Short story, Goal (prefilled from step 1, same value), Optional deadline, Organizer display name. AI actions: "✦ Ask Daali to help write your story", "Improve my fundraiser description". A live preview card under the form shows the cover, "Community fundraiser" chip, name, "Organized by {display name}", story line, progress bar and "$X raised of $Y".

Text has two levels. **Short description** (step 1) feeds cards, previews and the public page intro. **Story** (step 3's "Short story" field) feeds "Why this matters". No third field.

### Step 4 — Review

Heading "Review your fundraiser" / "This is what supporters will see." Shows the preview card, then Goal, Payment methods ("Venmo · Zelle"), Organizer, and the longer story. Actions: "Edit", "Publish fundraiser". Footnote: "You can manage or update payment details later from the fundraiser workspace."

Publish fundraiser goes to the fundraiser workspace: Overview, Goal and progress, Contributions, Payment methods, Public page, Recent activity, and Ask Daali / What needs attention. No Board concept appears in it. Raised amount and supporter count come only from organizer-confirmed contributions.

## Manual Raffle flow

Three steps, breadcrumb "/ New raffle", section label "CREATE A RAFFLE". Raffle is standalone; linking an Event is optional. The setup screens can be built once the Raffle backend exists, but entry issuance waits for the backend and legal/compliance rules.

### Step 1 — Raffle basics

Heading "Let's create your raffle." / "Start with the raffle details." Tip card: "A simple start" / "Add the prize and drawing date now. You'll set up entries and sharing next."

| Field | Placeholder |
| --- | --- |
| Raffle name | e.g., Booster Club Fall Raffle |
| Prize | What can someone win? |
| Drawing date | Select a date |
| Short description | Share the purpose of this raffle and what supporters should know… |

Organizer display name (new) defaults from the organizer profile and is editable here. Review reads it.

Actions: "Back to Your Daali", "Ask Daali for help", "Continue".

### Step 2 — Entries

Heading "Set up the entries" / "Choose how people enter your raffle."

| Field | Example |
| --- | --- |
| Entry price | $ 10.00 |
| Number of entries per purchase | 1 |
| Optional maximum entries per person | No maximum |
| Drawing date | November 7, 2026 (prefilled from step 1) |
| Drawing time | 6:00 PM |
| Offer a free-entry method (Optional) | "Share simple instructions for anyone who wants to enter without contributing." → Add instructions |
| Connect this raffle | Homecoming Tailgate · Event (picker of the organizer's Events; may be empty) |

Actions: "Back", "Continue".

### Step 3 — Review

Heading "Review your raffle" / "Check the public details before you publish." A preview card shows "Community raffle", name, "Prize: …", "$10 per entry", "Drawing Nov 7 · 6:00 PM" and an "Enter the raffle" button (inert in preview). Below: Entry structure, Drawing, Organizer.

Actions: "Edit", "Publish raffle". Footnote: "You can update eligible details after publishing." That implies a mutability contract like `eventCore`, for example entry price locked after the first entry.

### Entries, drawing and workspace

- **Separate concepts.** Contribution or payment evidence, entry issuance, the free-entry path, eligibility and the drawing are separate records. "Money received = raffle entry" must never become an accidental database invariant.
- **No fake Enter.** "Enter the raffle" is not built, on Review or the public page, until the entry architecture exists.
- **Drawing.** System-executed and auditable. The organizer initiates; the system selects from eligible entries; the result is recorded permanently with drawing metadata. The organizer never types a winner. Detailed rules come with the Raffle architecture.
- **Workspace:** Overview, Prize, Entry configuration, Entries, Free-entry method, Drawing, Linked Event, Public page, Activity.

## Shared commands

Every write goes through one command, whoever triggers it. The AI path differs only in the actor stamp (`AGENT`, `onBehalfOfUserId`, `planExecutionId`), never in the command or its rules.

| Command | Manual trigger | AI trigger | Exists |
| --- | --- | --- | --- |
| `createEvent` | Event Review → Create event | Approved plan → Review → Create event | Yes (0A) |
| `updateEvent` | Edit event, Overview → Edit details | Approved change proposal | Yes (0A) |
| `publishEvent` | Draft workspace → Publish event | Never; organizer only | Yes (0A) |
| `closeEvent` | Live workspace → ••• → Close event | Never | Yes (0A) |
| Add, edit, remove, open/close slot | Manage volunteers | Approved proposal (after the draft exists) | Add and open/close yes (0C); edit and remove to confirm in audit |
| `registerForEvent` | Public RSVP form | Never | Yes (0B) |
| Organizer remove registration | View guests → remove | Never | Yes (0B) |
| `claimSlot` | Public inline Sign up / I'll bring this | Never | Yes (0C) |
| Cancel registration / sign-up | Guest's emailed manage link | Never | Yes (0B, 0C) |
| Create and publish fundraiser\* | Fundraiser Review → Publish fundraiser | Approved plan → Review | No; waits for Fundraiser root |
| Save payment method details\* | Payment method drawer | Never | No |
| Confirm contribution\* | Fundraiser workspace | Never | No |
| Create and publish raffle\* | Raffle Review → Publish raffle | Approved plan → Review | No; waits for Raffle backend |
| Run drawing\* | Raffle workspace → Drawing | Never | No |
| Link raffle to event\* | "Connect this raffle" | Approved plan | No |

\* Placeholder names until the Fundraiser and Raffle architecture is decided.

Rules carried from the 0A–0D plan: commands return expected failures (`CAPACITY_EXCEEDED`, `SLOT_FULL`, `CONTENTION`) as results, not exceptions; each Review or public form render carries one idempotency key; `kind === 'AGENT'` never appears in `src/domain/`.

## Event management

One workspace, breadcrumb "/ {event name}", serves both Draft and Live. It reads 0B and 0C data; AI panels appear above the sections and change nothing without approval.

### Header by state

| State | Chip | Actions | ••• menu |
| --- | --- | --- | --- |
| Draft | Draft | Preview public page, Edit event, Publish event (primary) | Hidden (no valid action) |
| Live | Live | View public page, Edit event | Close event |
| Closed | Closed copy | View public page | Hidden |

Publish is organizer-only; Daali never publishes. The ••• menu holds only actions with real commands. Cancel and Delete are added when their lifecycle rules exist. "Past" is a presentation state derived from `endsAt`, not a new status.

**Publish and the page address (Slice 4).** Publish event opens one short step, "Choose your page address", before the event goes live. The field is prefilled with a suggestion built from the event name, shows the full `daali.app/…` address as the organizer types, and checks availability live; a taken address offers a free variant. Confirming runs claimVanityPath and publishEvent as one approved action. Whether an address is required or can be skipped is decision U3 in the Vanity Path Addendum (recommended: required, always prefilled). Once live, the workspace's public-page area shows the address with Copy and Change; Change warns that the old address keeps working and forwards to the new one. Daali may propose an address in a plan; only the organizer confirms it. No frame exists for either surface (see Visual review).

### Ask Daali bar

Input "What do you want help with?", primary "Ask Daali". Chips: What needs attention?, Summarize RSVPs, Help me promote this, Show open volunteer spots. Every response is a structured insight panel; the workspace never becomes a chat transcript.

### Sections, in one card

| Section | Subtitle | Shows | Link | Source |
| --- | --- | --- | --- | --- |
| Overview | The essentials guests see on your event page. | Date & time, Location, Capacity | Edit details | `Event` |
| RSVPs | A clear view of attendance — no extra charts. | Attending, Remaining spots, "N new responses since {day}" | View guests | `SUM(partySize)` over CONFIRMED; capacity minus seats |
| Volunteers | Keep shifts and shared items coordinated. | "N open shifts", "N requested items" | Manage volunteers | Slots with free positions |
| Updates | Recent activity across this event. | Activity line + relative time | none | `RegistrationLog` + `SignupLog` |

A section appears only when its tool is on. An uncapped event shows Attending without Remaining spots.

### Edit event

The same fields as Event basics: name, date and time, venue name, address, description, cover photo, plus Guest capacity when RSVP is on. Field locks and reasons come from the `eventCore` mutability contract. Organizing tools are managed separately, not inside this form.

### View guests

A searchable roster: Name, Email, Party size, RSVP status, Response/update time. The organizer may remove a registration with the existing organizer command. No attendee editing beyond supported commands.

### Manage volunteers

One workspace with two sections, Shifts and Items & supplies. The organizer can add, edit and remove slots, open and close sign-ups, and view commitments per slot. RSVP independence holds: volunteering or bringing an item never requires attending.

### AI insight panels

Two request classes, and the distinction carries into the future API:

1. **Read request** — answered from real event state. Numbers always come from deterministic queries; Daali may summarize or explain them.
2. **Change request** — Daali builds a proposal showing exactly what it wants to change. The normal command runs only after the organizer approves.

| Panel | Content | Actions |
| --- | --- | --- |
| RSVP summary | "Based on current guest responses", "Updated just now", three stat tiles (attending, spots remaining, new since Monday), one-sentence read | View guests, Ask another question |
| What needs attention | "A current view across this event", "N areas checked", one row per area with status and link (Review shifts, View items, "No action needed"), footer "Daali surfaces what changed and leaves every decision with you." | Row links |
| Show open volunteer spots | Deterministic list: shift or item, time if any, filled / capacity, remaining; optional one-sentence summary | Manage volunteers |
| Help me promote this | Draft-only: short social caption, longer social post, email/text copy, and the event highlights Daali used | Copy; nothing is sent |
| Free-text read | Same panel shape, answer from deterministic data | Ask another question |
| Free-text change | Proposal panel listing each change, "Proposal only" | Approve, Adjust |

The model writes summaries and drafts only. It never calculates a number shown in a panel.

## Public pages

Event, Fundraiser and Raffle each get a public page that emphasizes story and participation, with no organizer controls. Event and Fundraiser have frames; Raffle's content is decided and composes from the same components.

### Public Event (`daali.app/<address>`; internal route `/e/[slug]`)

| Block | Content | Behavior |
| --- | --- | --- |
| Hero | Cover photo | No photo → the standard Daali visual treatment |
| Header | "Hosted by {organizer}", title, date/time and location chips, description | Host line from organizer display name |
| Are you coming? | "Save your place and tell us how many people are joining you." Name, Email, Party size; RSVP button | `registerForEvent`; shown only when RSVP is on and the status accepts registrations |
| Want to help? | "Choose a volunteer shift that fits your day." Rows: "{shift} · {time} · N spots" + Sign up | Inline form on the row: Name, Email. `claimSlot` on a SHIFT; no RSVP required |
| Bring something | "Pick an item to bring and help make the table complete." Rows: "{item} · N remaining" + I'll bring this | Inline form: Name, Email, Quantity. `claimSlot` on an ITEM |

After a successful claim the inline form becomes a confirmation, and the normal confirmation and manage link goes out through the notification path. The RSVP button defaults to "RSVP" (the frame's "RSVP to the tailgate" has no defined rule).

**Closed:** the page still resolves; event information stays readable and participation controls are replaced with clear closed copy ("Registration is closed." from `publicStateCopy`). **Past:** derived from `endsAt` for display only; no new lifecycle.

**Address.** A published event is served at the organizer's address, `daali.app/<address>`, and that address stays in the browser for the whole visit, including RSVP and volunteer sign-up. `/e/[slug]` remains an internal route: it forwards to the organizer's address when one exists, so old links, emails and returns all land there. A retired address, or a different spelling of the current one, forwards to the current address. The page's canonical link, share button and emails all use the organizer's address. Rules are in the Vanity Path Addendum.

### Public Fundraiser

| Block | Content | Behavior |
| --- | --- | --- |
| Hero | Full-bleed cover photo | Standard treatment if none |
| Header | "Organized by {display name}", name, Short description |  |
| Progress card | "$X raised", "of $Y goal · N supporters", progress bar, primary "Support the {fundraiser}" | Amounts from organizer-confirmed contributions; Support scrolls to Ways to contribute |
| Why this matters | Story |  |
| Ways to contribute | "Choose the familiar payment method that works best for you." Rows: "{method} · {handle}" + View details | View details opens a small surface with the handle or link and Copy / Open actions |
| Activity line | Deterministic line, e.g. supporter count or recent confirmed contributions | Replaces the Community support quote card; only once the contribution model exists |

Supporter quotes are removed from MVP. This page applies only to Fundraiser-root records; Hampton's live page is unchanged.

### Public Raffle

Prize and hero, purpose and description, entry structure, drawing date and time, free-entry instructions where applicable, and the linked Event when present. The Enter action is added only once the entry architecture exists; until then there is no Enter control, not a disabled or fake one.

## AI permissions

Daali may read, summarize, draft and propose. Any change to a record requires explicit organizer approval, and publishing, closing and drawing are always the organizer's own action. Manual and AI are two ways into the same system, not two systems.

### The four questions every feature answers before build

1. What state can Daali read?
2. What deterministic commands can Daali propose?
3. What requires explicit organizer approval?
4. What is Daali never allowed to do?

A feature spec without these four answers is not ready to build.

### Current answers

| Action | Daali may | Approval |
| --- | --- | --- |
| Interpret a request and recommend capabilities | Yes | None; it is a proposal |
| Revise or edit a proposal | Yes | None; nothing is written |
| Prefill creation fields (including venue, address, guest capacity) | Yes, when confident | Shown on Review; Create is the approval |
| Propose shifts and items | Yes, after the draft exists | Required before creation |
| Draft descriptions, stories, promotion copy | Yes | Inserted only when accepted |
| Answer read requests (summaries, attention, open spots) | Yes; numbers from deterministic queries | None |
| Change request on an existing item | Propose the exact change | Required; then the normal command runs |
| Create an Event, Fundraiser or Raffle | Only by executing an approved plan | Required |
| Publish, close or cancel anything | Never | Organizer action only |
| Initiate a raffle drawing or pick a winner | Never | Organizer initiates; system selects |
| Edit payment details or confirm contributions | Never | Organizer action only |
| Estimate raised amounts or contributions | Never | Not allowed |
| Send messages to guests, volunteers or supporters | Draft only | Sending is out of scope |
| RSVP or sign up on someone's behalf | Never | Not allowed |

Every AI-executed write carries the `AGENT` actor stamp, so the roster and logs can show "added by Daali" as 0B already does.

## Shared states: loading, errors, offline

Each state is built once as a shared component and reused on every screen. No state uses "Coming soon".

| State | Behavior |
| --- | --- |
| No organizer items | The designed Your Daali empty state |
| Section with no data | Section stays, with one muted line in the empty-state tone. No illustration |
| Loading | Card-shaped skeletons matching the destination layout. Never a full-page spinner |
| Failed action | The page stays usable. The error shows nearest the failed action, with Retry when retrying is safe |
| Field validation | Persistent label, one short line under the field |
| `CAPACITY_EXCEEDED` | Inline under the RSVP form, stating seats left |
| `SLOT_FULL` | Inline on the row; the row shows full |
| `CONTENTION` | "Several people signed up at once. Try again." (0C copy) |
| Duplicate submit | Replays silently through the idempotency key |
| Offline | Small persistent banner. Writes are never queued and sent later; no offline queue exists |
| Connection lost mid-setup | Unsaved multi-step data stays in the current browser session, so nothing the organizer typed is lost |
| AI cannot interpret / unavailable | See "When Daali cannot help" under AI path |

## Mobile behavior

Mobile is the complete product at 390 px, never a reduced feature set, and there are no mobile-only product rules. Review stays the convergence point and AI stays optional and available.

Rules: 24 px gutters; stacked cards; full-width primary actions; inline panels become vertical; tables become compact cards or rows; wrapping chips; no sidebar; the header keeps the avatar and drops the name.

| Screen | Mobile frame shows |
| --- | --- |
| Your Daali | Multi-line AI input with full-width "Plan with Daali"; type cards without icons; item cards collapsed to name and "{type} · {status} · {meta}" (View page and the AI shortcut stay as compact secondary actions, O12) |
| Plan with Daali | Own screen: "PLAN WITH DAALI", "Tell us what you're organizing.", "Start with the people, purpose, or help you need. You'll review every suggestion.", footer "Daali prepares a proposal. Nothing is created until you approve." |
| Recommendation | Own screen: "YOUR REQUEST" card, then the proposal; Looks good and Adjust stacked full width |
| Event step 2 | Stepper as chips; Back and Continue side by side |
| Event management | View page and Edit event side by side; "Ask Daali" card with two chips; sections condensed; "36 left" |
| Public Event | Fields stack; each row's action on its own line |

Every other screen is built from these rules without a dedicated frame.

## Visual review for screens without frames

Every behavior gap is now decided, but several decided screens have no Figma frame. They compose from UI system 1.0 components, and each goes through design review against the visual acceptance gate before it ships.

| Slice | Decided screens without a frame |
| --- | --- |
| 1–2 Home | Avatar menu; empty-input prompt |
| 3 Manual Event | Cover photo and Venue/Address fields; Guest capacity under RSVP |
| 4 Event manage + public | Draft workspace with Publish; Choose your page address step; address with Copy and Change; ••• menu; View guests; Manage volunteers; Edit event; inline public sign-up and confirmation; closed state |
| 5 AI Event | Inline-expanded plan card; cannot-interpret and unavailable messages; promotion, open-spots and change-proposal panels |
| 6 Fundraiser | Payment method drawer; method detail surface; fundraiser workspace; activity line |
| 7 Raffle | Raffle workspace; public raffle page; drawing |
| All | Skeletons, inline error with Retry, offline banner |
