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

/**
 * Deep-strip U+0000 from every string KEY and VALUE of a JSON-shaped value,
 * returning a structurally identical copy that is safe to `JSON.stringify`
 * into a `jsonb` column.
 *
 * Why this exists separately from `stripNulBytes`: applying that function to
 * the ALREADY-SERIALISED JSON text does nothing, because `JSON.stringify`
 * ESCAPES U+0000 rather than emitting it raw. Serialising an object whose
 * value holds one yields the six ASCII characters of a lowercase-u Unicode
 * escape inside the JSON text -- no NUL byte anywhere -- so the
 * `value.includes(...)` guard in `stripNulBytes` finds nothing and returns
 * the string untouched. Sanitising the serialised JSON is a silent no-op.
 *
 * Postgres rejects it all the same, just one layer further in and with a
 * different error than the `text` case: "unsupported Unicode escape
 * sequence", detail "...cannot be converted to text". `jsonb` is a parsed,
 * decoded representation, so every string it holds must be representable as
 * `text` -- and `text` cannot hold a NUL. (Plain `json` would have accepted
 * it, storing the escape verbatim; `jsonb` does not.) The substitution
 * therefore has to happen on the JS values BEFORE serialisation, which is
 * what this function does.
 *
 * Same U+FFFD replacement as `stripNulBytes`, for the same reasons, so a
 * diagnostic's `detection`/`network` blocks and its `html` agree on what a
 * NUL became. Found by the PR #675 review (B4): the diagnostic route
 * sanitised `url`/`html`/`title` but passed `detection`/`network` straight to
 * `JSON.stringify`, reopening for JSONB exactly the production 500 that
 * issue #207 / PR #563 closed for `text`.
 */
export function stripNulBytesDeep<T>(value: T): T {
  if (typeof value === "string") {
    return stripNulBytes(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNulBytesDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Keys need it too -- a `jsonb` object key is `text` like any other.
      out[stripNulBytes(key)] = stripNulBytesDeep(val);
    }
    return out as unknown as T;
  }
  return value;
}
