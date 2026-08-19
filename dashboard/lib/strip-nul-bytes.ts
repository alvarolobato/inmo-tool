/**
 * Replace U+0000 with U+FFFD before the row reaches Postgres.
 *
 * A `text` column cannot hold a NUL byte — the driver reports
 * `invalid byte sequence for encoding "UTF8": 0x00` and the whole INSERT
 * fails, so the endpoint 500s and the operator's capture is lost with a
 * message that says nothing about why. Found in production on the first real
 * Hipoges capture (issue #207): its rendered DOM carries a NUL. Nothing is
 * Hipoges-specific about it — any portal can serialise one, and this endpoint
 * had no guard at all, so this was a latent 500 for every source.
 *
 * U+FFFD (REPLACEMENT CHARACTER) rather than deletion, for three reasons:
 * it is the Unicode-sanctioned replacement, it preserves every downstream
 * character offset (deleting would silently shift them), and it is what
 * Python's `html.unescape` and BeautifulSoup independently produce for the
 * same input — so the ETL side already agrees with this choice.
 *
 * NOT because 'the browser saw U+FFFD': the capture is
 * `document.documentElement.outerHTML`, a serialisation of the RENDERED DOM,
 * so the HTML tokenizer's own U+0000 -> U+FFFD substitution already happened
 * at parse time. A NUL surviving into `outerHTML` means script wrote it into
 * a text node after parsing. (PR #563 review, nit 7 — an earlier version of
 * this comment had the causal story backwards.)
 *
 * Note U+0000 is one UTF-8 byte and U+FFFD is three, so substitution can grow
 * a payload up to 3x. The caller checks its size cap BEFORE sanitising, on
 * purpose — the cap is there to bound what the extension may SEND, not what
 * we store — so a pathological all-NUL body can be stored larger than the cap
 * suggests. Bounded, admin-key gated, and the html column is nulled once the
 * capture reaches 'done'.
 */
export function stripNulBytes(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value;
}
