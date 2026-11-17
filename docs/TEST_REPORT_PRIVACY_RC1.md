# RC.1 privacy verification

Date: 2026-11-14. Scope: P0-4 password detection, conservative full-frame blocking, fail-closed input and diagnostic redaction. The accepted behavior is **whole-sensitive-frame blocking**, not verified selective masking of real application bitmaps.

## Reproduction and superseded results

The screenshot SDK does not expose the required `IsPassword` property in its TypeScript element contract, so an independent fixed Windows UIA helper checks the bound window. An initial WinForms run incorrectly treated an empty subtree as complete. Explicit client-side provider registration and fail-closed empty-tree handling addressed that false-clear case. The helper now checks the root and subtree, rejects oversized/unbounded/mismatched observations, and keeps scanning passwords after the target-candidate cap is reached.

Two subsequent partial-mask checks produced false-positive acceptance:

1. Checking only the projected mask centre found a black pixel, but visual inspection showed the mask below the password field.
2. Enabling per-monitor DPI awareness made UIA bounds agree with an independent `GetWindowRect` query. Checking all pixels in the rectangle projected from those coordinates still passed, but visual inspection continued to show the password field's asterisks outside the mask. Both checks shared an unproven mapping from physical bounds into bitmap content.

**Both prior success claims are superseded.** Physical UIA/HWND coordinate agreement is not proof of screenshot pixel alignment. The underlying selective-mapping problem is not claimed fixed. A reproducible controlled comparison is retained as before-selective-mask.png. It uses the helper's internal verified-projection argument only to reproduce the old partial-mask behavior; production tools and configuration cannot set that argument.

## Production correction

Production uses the helper's default unverified-projection policy. Any detected password region or any configured exclusion rectangle makes every output pixel black, sets `privacy.status:blocked` and `reason:sensitive-geometry-unverified`, suppresses frame UIA text and suggested targets, and prevents input from that frame. A title-blacklist match also blocks the entire frame with `reason:private-window-title`. Incomplete scans and desktop-wide capture remain fully blocked.

This avoids relying on an uncertain rectangle transform. It costs compatibility: a window containing a detected password, or any configured exclusion rectangle, cannot be used for image-guided or UIA input through that observation. Nonexcluded portions of such a window are withheld too. Synthetic tests still exercise partial masking where the bitmap mapping is explicitly known; those tests do not certify production screenshot geometry.

## Final live result

Executed controlled test: `node --import tsx tests/privacy.windows.integration.ts`. It creates its own synthetic WinForms fixture, captures only that window, and terminates the exact child process in a finalizer. The password is synthetic test data. The current test asserts that **every output image pixel is black**, independent of which rectangle a coordinate transform would select.

Final JSON, final log, whole-frame black output, [test source](../tests/privacy.windows.integration.ts).

| Check | Observed result |
| --- | --- |
| Policy | `whole-sensitive-frame-blocked` |
| Window password regions detected | 1 |
| Root `IsPassword` control included | 1 |
| Public UTF-8 name read by scanner | Pass; not exposed in the blocked frame |
| Empty root-only non-password tree | Blocked |
| Foreign PID | Blocked |
| Debug payload | Absent |
| UIA/HWND physical bounds agreement | Observed; not accepted as bitmap alignment proof |
| Every output pixel black | Pass (`allOutputPixelsBlack:true`) |
| Privacy receipt | `blocked`, `sensitive-geometry-unverified` |

The fully black output was also visually inspected. This evidence supports the conservative blocking policy only. It is not a full Harness/model-upload integration test or proof of selective region fidelity.

## Automated regression checks

`node --import tsx --test tests/privacy.test.ts`: **6 passed, 0 failed**, recorded in unit log.

The tests preserve synthetic verified-mapping checks for partial masks, negative monitor coordinates, cropping/resizing and nonexcluded pixels. Additional checks verify that unverified sensitive geometry blocks every pixel, blocked frames reject input even when the password scan completed, and frame UIA text is suppressed. Title, malformed geometry, invalid HWND, secret/credential/username redaction and execution-input immutability remain covered. See the overall release report for the final broader-suite count.

## Disclosure and remaining limits

[PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) describe the full-frame policy, its usability cost, local retention, the usable-path exception and possible transfer to the configured model through Harness. Raw bitmap/UIA data exist transiently before blocking; stopping the plugin cannot retract host/provider copies already sent.

Selective masking across real application bitmaps remains unverified. Detection depends on correct application `IsPassword` semantics; ordinary text, custom rendering and window discovery metadata are not a universal secret detector. A verified private vulnerability-reporting endpoint also remains publication setup work because the source snapshot has no configured repository remote or maintainer contact.
