# Design, saved-library and cart behavior

Live clouds supply words. The editor holds a working design. Saving to an account,
adding or updating a cart item, and placing an order each create a separate
accepted version. A change to one must never silently change another.

This contract covers the implemented behavior for live clouds, independent
designs, the account library, browser recovery, cart editing, checkout and
failures. These changes are local source changes; deployment requires separate
maintainer approval. The basket remains scoped to its workspace/event, with
navigation to other retained browser baskets.

## The four versions people need to understand

| Concept | What it means to the customer | How it changes |
|---|---|---|
| Live cloud | Contributions collected for this event | Guest submissions and organizer actions |
| Working design | The artwork currently being edited, including all print sides and product choices | Editing, an explicit rebuild or an explicit restore; browser recovery saves this working copy locally |
| Account design | A reusable design saved in the private library | Only an explicit account save or update |
| Cart item | The exact product and artwork selected for purchase | Only an explicit add or update of that item |

A paid order uses its frozen purchase version. Later edits, cloud changes,
account saves, deletion from the library and cart updates cannot change it.

Use the destination in action labels: **Im Konto speichern**, **Gespeichertes
Design aktualisieren**, **In den Warenkorb**, and **Warenkorb aktualisieren**.
Avoid a generic “Design aktualisieren” where the customer cannot tell which
version will change. Browser recovery is automatic; account saving remains
manual and optional.

## Opening a design

Opening is always a read or a restoration. It does not approve artwork for the
cart, overwrite a library design or import newer live words into existing artwork.
The editing target must remain stable when a browser draft is present or absent.

| Entry or condition | What opens | Cloud behavior and purchase consequence |
|---|---|---|
| First design from a populated live cloud | A new automatic working design using the fetched words | No change notice; adding to cart is explicit |
| First design from an empty live cloud | A clear empty state with actions to collect words or start an independent custom design | No failed-rebuild button and no automatic redirect or purchase |
| Return to an existing live-cloud draft | The last recoverable working copy | Compare its word snapshot with the current cloud; never replace it automatically |
| Direct custom design | A blank new design or its browser working copy | No live source, cloud notice or cloud rebuild |
| Open an account library design | Its current saved version, or identified pending edits to that library design | It opens in an independent workspace; its saved word list is not a live connection |
| Library design with local work and the same server version | Resume the local working copy | Show a compact “Ungespeicherte Änderungen wiederhergestellt” message only when it actually differs from the account save |
| Library design advanced on another device, local copy unchanged | Open the newer saved version | Do not substitute an older clean browser copy |
| Library design advanced elsewhere, local copy has edits | Preserve both versions and offer opening the latest saved version or keeping local work as a new design | Never silently overwrite either version; comparison is for the account, not the cloud |
| Open a cart item, no pending edits | A working copy of that exact cart snapshot | The editor targets that cart item; a cloud difference is advisory |
| Open a cart item with pending local edits | Resume those edits | Clearly mark that the cart still contains the previous version |
| Return from shipping | The same cart item's working copy | Retain quantities and address draft; prices remain subject to a fresh authoritative check when required |
| Open a detached immutable design link | A new working copy of that snapshot | Do not assume that the design is already in this browser's cart |
| Original live event no longer available, account design still exists | Open the account design in its independent workspace | No original-event dependency and no cloud rebuild |

Library and cart editing should be independent targets. **Open from the library**
edits the library working copy; **Edit from the cart** edits that purchase item.
Preserve optional authenticated origin information, but it must not turn cart
editing into an implicit update of the original library design. A cart edit can
offer an explicit “Als neues Design speichern” action. Updating an existing
library design from a cart copy requires deliberately selecting and validating
that library target.

Apply the same cart-entry rule to local recovery and server restoration: both
open the selected cart item as the purchase editing target. A library origin is
metadata until an authenticated customer deliberately chooses that library
design as a save destination. Its presence in a browser draft must not silently
change the account-save action.

If a library draft currently carries a cart association, normalize it into the
library editing target when entering through the library. Preserve its pending
cart working copy separately. Otherwise the presence of a browser draft changes
“Add” into “Update,” which is not predictable.

If an independent library design is already represented in the active cart,
do not silently replace that item. Before another addition, offer **Vorhandenes
Design im Warenkorb bearbeiten** or **Als weiteres Design hinzufügen**. If several
items match the origin, show their product and artwork so the customer can choose
the intended one. Do not merge different artwork or infer identity from equal
word lists, product names or image similarity.

## When the cloud notice appears

There are three independent comparisons:

- **Cloud changes:** the latest valid event words and counts differ from the
  word snapshot last used by this working design.
- **Account changes:** the working design differs from the accepted account
  version.
- **Cart changes:** the working print composition or product differs from the
  accepted cart version.

One comparison must not set the other two. New cloud contributions alone do not
make a cart item invalid or create unsaved artwork. A recolored or manually
edited design can have pending cart changes even when the cloud is identical.

The cloud notice requires a real live-event source and a successful check.
Independent custom and account-library workspaces have no live source, including
when their imported snapshot contains words. Never infer a live source from
those saved words or automatically search for the original event.

Check when opening, returning to the editor and regaining visibility or focus.
Provide an explicit **Aktuelle Wörter prüfen** action for designs with a live
source. If continuous availability updates are wanted while the editor remains
visible, use a bounded check, at most once per minute with one request in flight;
only the notice can change. The canvas must never follow incoming words during
manual editing. Hidden pages should not poll.

Compare exact normalized word/count pairs independently of array order. Added
or removed words, case-sensitive word changes and changed submission counts
qualify. Event title, language, theme or layout-engine changes do not qualify as
new words. Rechecking an identical result is a no-op.

The notice is information, not a checkout warning. Recommended copy:

> Die Wortwolke hat sich geändert. Euer Design bleibt unverändert.

Offer **Mit aktuellen Wörtern neu gestalten** and **Dieses Design behalten**.
Keeping the design dismisses this particular source change for the working copy;
a different later source snapshot may show a new notice. The dismissal is a local
view preference, not an account or cart save. A manual source check remains
available and deliberately reopens the choices after a successful check, so
people can reconsider a kept design. Do not tell people that they must “update”
a valid accepted design.

## Rebuilding with current words

“Rebuild” replaces the composition. It is not a promise to merge new words into
manual artwork while preserving placements, deleted words or added images.
Retain the selected product, orientation and palette, including custom palette
colors. Generate a new automatic arrangement of the checked words on all current
print sides. Manual text formatting, added elements and previous arrangements
are replaced; explain this before committing.

The action works in this order:

1. Load and validate a fresh source snapshot. Distinguish no words, an unavailable
   source and a network failure before offering a destructive confirmation.
2. Prepare fonts, emoji and all print-side layouts without mutating the working
   design. If the checked cloud has returned to the working design's original
   word snapshot, clear the notice without erasing manual edits.
3. For existing manual artwork, cart copies or account-linked work, show the
   replacement scope and a preview or clear change summary. An untouched new
   automatic draft can rebuild directly with Undo available.
4. On confirmation, commit the complete prepared replacement as one action.
   Preserve a full pre-rebuild checkpoint, including hidden back content,
   retained product arrangements and the word-source snapshot.
5. Clear the notice for that source snapshot and show **Design neu erstellt**
   with **Rückgängig**. Recompute account and cart differences independently.

Confirmation title: **Aktuelle Gestaltung ersetzen?**

Suggested body, with only relevant destination sentences included:

> Die Gestaltung auf allen Druckseiten wird mit den aktuellen Wörtern neu
> erstellt. Eigene Texte, Bilder und Anpassungen werden ersetzt. Ihr könnt die
> Änderung rückgängig machen. Das gespeicherte Design im Konto bleibt
> unverändert. Das Design im Warenkorb bleibt unverändert, bis ihr den Warenkorb
> aktualisiert.

Cancel and Escape leave artwork, source snapshot and all save targets unchanged.
Undo restores the whole working design, including both sides and source metadata.
Undo never silently reverses an account save or a cart update already accepted
after the rebuild; it creates pending changes relative to those accepted versions.
The latest rebuild checkpoint and its Redo are available during the current
editor session. Reloading restores the working artwork, not the Undo history.
The ordinary toolbar Undo crosses the rebuild boundary after subsequent editor
edits have been undone; the explicit rebuild Undo restores the entire checkpoint
in one action. Editing after Undo clears rebuild Redo.
This follows established guidance to make consequential edits reversible and
keep a clear exit available. [User Control and Freedom](https://www.nngroup.com/articles/user-control-and-freedom/)

Keep progress and failure feedback beside the rebuild action, including in the
mobile editor. Disable duplicate submission while busy. A failed action needs a
persistent reason and a retry action in that same context; a briefly disappearing
loader and an error below the purchase buttons are insufficient feedback.
[Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/)
and [Error Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/)
support immediate feedback and errors close to the action that failed.

## Saving and ordering

| Action or state | Working design | Account library | Cart and order |
|---|---|---|---|
| Manual edit or cloud rebuild | Changes; local recovery saves it | Unchanged | Unchanged |
| Save a new account design | Continues editing the same copy | Creates a new named saved version | Unchanged; saving does not add a purchase |
| Update an account design | Continues editing the same copy | Replaces only the explicitly selected saved design with version checking | Unchanged, including copies previously added to cart |
| Save as a new account design | Gets the new account target | Creates a separate design; original remains | Unchanged |
| Add a new design to cart | Becomes the working copy of the new cart item | Unchanged | Adds exactly one accepted immutable snapshot |
| Update a cart item | Keeps that item's editing target | Unchanged | Replaces exactly that item's version and product; keeps quantity, position and address draft |
| Change product or orientation | Transfers current edited content and print sides | Unchanged | Pending update if editing a cart item; no extra cart item |
| Start another product | Creates a separate working copy with its own identity | Original unchanged; account target is detached from the new copy | Original unchanged; new copy is not added automatically |
| Keep the existing cart at checkout review | Local edits remain recoverable | Unchanged | Orders the displayed accepted cart versions |
| Apply selected edits at checkout review | Selected working copies become accepted | Unchanged | Updates only explicitly selected cart items; new designs are clearly labeled additions |
| Remove a cart item | Can remain available for editing | Unchanged | Removes it; never automatically re-adds it; existing ten-minute removal Undo remains |
| Delete a library design or account | Private access and related drafts follow ownership rules | Deleted through the existing explicit deletion flow | Independent accepted cart and paid order snapshots remain |
| Order succeeds | Later work remains separate | Existing payment-linked renewal rules remain | Freezes the purchase; only the exact purchased cart versions are cleared |
| Reorder a previous purchase | Creates an independent working or purchase copy | Unchanged | Uses a new cart/order snapshot and fresh pricing; never edits the old order |

If both account and cart targets are available for an explicitly connected
working copy, show both controls and their separate pending states. Saving one
must not make the other appear updated. A save in flight accepts the version
captured at submission; any newer edits remain pending.

Before proceeding to shipping, review pending edits to all relevant cart items,
including items not currently open. Compare the accepted artwork with the
working artwork, including every print side. Offer using the existing cart,
applying selected changes, or returning to edit. Keep the existing no-dialog path
when the cart has no pending edits. Unsaved library changes alone must not block
an otherwise valid cart, and cloud differences must not require cart rebuilding.

The current basket is scoped to a workspace/event, so switching between a live
cloud and a library workspace can show a different basket. A consumer-facing
shop should ultimately present one visible site-wide basket. Until the backend
supports validated purchases across workspaces, identify the active basket and
provide access to the other retained baskets. Do not silently show an empty cart
as if the previous items vanished. Do not combine configuration IDs from different
events in the existing event-scoped checkout or weaken isolation to simulate a
global cart; that requires a separate trusted basket design.

## Empty sources and failures

| Condition | Expected behavior |
|---|---|
| Live cloud was cleared after a draft or cart snapshot existed | Restore the existing artwork. Show **Die Wortwolke enthält derzeit keine Wörter. Euer Design bleibt erhalten.** Do not rebuild to a blank design. Valid saved artwork can still be edited and used |
| Source check fails or times out | Preserve the artwork and last known source state. Show **Die aktuellen Wörter konnten nicht geprüft werden. Euer Design bleibt unverändert.** with retry; do not claim a new change was detected |
| Source becomes unavailable | Disable the source action with a generic unavailable explanation. Private saved designs can reopen independently; expired public event URLs retain their existing unknown-event behavior |
| Font, emoji, layout or editor commit fails during rebuild | Restore the complete previous state, not just the visible canvas. Keep the action retryable and clear its busy state |
| Browser draft storage fails | Preserve current in-memory artwork and show the existing actionable local-save warning. Do not silently claim recovery is available |
| Cart update fails | Keep the previous accepted item and the edited working copy. Do not navigate to shipping or mark the item updated |
| Cart approval succeeds but browser recovery fails | Keep the accepted cart snapshot and the persistent recovery warning. Stay in the editor so the failure or conflict copy can be reviewed; do not pretend that the cart approval failed or that recovery succeeded |
| Some reviewed cart updates succeeded, another failed | Preserve accepted successes and remaining pending edits. Show what still needs attention; do not continue automatically |
| Account save conflicts with a newer version | Preserve local work and offer opening the latest saved copy or saving local work as a new design. Never resolve by silently replacing the newer server version |
| Account session expires | Require authentication for private library access and library updates. Independent guest cart and checkout operations remain usable without an account |
| Account save commits but its response or local recovery fails | Reconcile the known server result using existing idempotency. Distinguish successful account saving from failed browser recovery; do not report that both failed |
| Cart is changed in another tab | Re-read the target before updating. A missing or replaced item cannot be silently re-added; offer opening the current item or an explicit new addition |
| The same working copy is edited in two tabs | Detect draft revision changes before overwriting local storage. Preserve a conflicting copy or ask which version to resume; account version checks alone do not protect local drafts |
| Local draft expired or another browser is used | Open the accepted account/cart version where accessible; explain that unsaved browser edits were local. Account login does not imply that guest baskets synchronize across devices |
| Blank or incomplete print side | Allow private work-in-progress saving. Keep the existing complete, validated print-side requirement before adding/updating a purchase |

Local drafts and cart references currently last seven days, shipping address and
quantity drafts up to 24 hours, and account designs three calendar months with
the existing activity-based renewals. Keep these recovery limits separate from
commerce retention and frozen paid artifacts. This implementation does not extend or
shorten retention.

## Investigation and implemented changes

| Original finding | Resolution |
|---|---|
| Independent library workspaces falsely showed a cloud-change banner | Source checks and notices require a live source. Independent workspaces never compare saved words with their empty workspace source |
| A cleared live cloud blocked existing editor restoration | `configurator?restore=1` returns metadata with empty words, allowing restoration. Blank live-cloud purchase approval remains rejected |
| Rebuild discarded editor history | A full checkpoint retains all print sides, editor state and retained product layouts; explicit and toolbar Undo/Redo restore it |
| A failed editor commit changed source metadata | Layout preparation happens before confirmation and mutation. A failed commit restores the previous complete checkpoint |
| Local account restoration ignored a newer server version | Opening compares the referenced version and accepted fingerprint. Clean old copies open the latest version; conflicting work stays recoverable with an explicit choice |
| Library and cart entry targets differed between recovery paths | Library entry clears the purchase target and preserves a separate pending purchase copy. Cart recovery detaches the private save target. An existing-library destination requires deliberate selection and versioned saving |
| Separate same-product copies shared a draft key | Working IDs remain stable across product changes. Revision checks preserve simultaneous-tab conflicts as separate copies |
| Save and cart snapshots were already separate | That foundation remains: account saves are manual; cart approval creates an immutable configuration; neither operation updates the other destination |
| Source checking happened only at startup and rebuild | Explicit checks, focus/visibility checks and bounded visible-page polling update source information without changing artwork |

Verification includes focused session, account, cart-review, loading-state,
mobile-workspace and basket-navigation regressions, database-backed configurator
and account tests, and the complete application suite. Browser checks used
synthetic localhost data for desktop and mobile-sized canvas interactions,
including replacement, Undo/Redo, empty-cloud restoration and independent
library/cart restoration. Actual iPhone Safari remains a separate device check;
the localhost mobile viewport is not evidence of a physical-device run.

Source locations: [editor restoration and approval](../views/configure.ejs),
[browser drafts and cart references](../public/js/configurator-session.js),
[account restoration and manual saving](../public/js/account.js),
[configuration bootstrap and immutable reads](../src/routes/events.js),
[private snapshot format](../src/savedDesigns.js),
[independent library workspace creation](../src/db.js).

## Implementation boundaries and acceptance

Track a stable working-design identity, explicit editing target, optional
authenticated library origin, optional live-event source and separate accepted
account/cart fingerprints. Product and orientation are properties of a working
design, not its identity. Replacing an immutable configuration changes the cart
item's accepted version, not which logical item the editor is targeting.

Availability checks and dismissed notices belong to local view state. Live-source
provenance is explicit. Preserve the existing independent account-workspace
policy; linking an account design back to a cloud would be a separate explicit
product feature, not a guessed relationship.

The implementation uses the existing configurator, trusted normalization and
immutable output. Event isolation and guest checkout remain intact. A site-wide
checkout is a separate purchase architecture change; the shared menu exposes
retained scoped baskets without mixing their configuration IDs.

Acceptance must cover each table above. In particular, verify unchanged artwork
after source changes; clearing a cloud with existing work; local and server
restoration of the same target; account-save/cart-update independence in both
directions; whole-design rebuild Undo; both-sided and hidden-back recovery;
empty, failed and reverted source checks; mid-commit rollback; duplicate clicks;
library version conflicts; separate same-product drafts; cross-tab replacement;
partial cart-review failure; quantities and address retention; expired sessions;
and immutable purchased output. Browser acceptance should include desktop and
mobile Safari for the rebuild and return-to-editor flows.
