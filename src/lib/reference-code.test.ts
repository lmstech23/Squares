import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateReferenceCode,
  normalizeReferenceCode,
  looksLikeReferenceCode,
  reservationSearchTerms,
  CODE_LENGTH,
} from "./reference-code.ts";

// The generator and the normaliser are tested together on purpose: the second
// is only SAFE because of what the first refuses to emit. Split them across two
// files and someone widens the alphabet without ever reading the mapping.

// The exact character class in the database CHECK,
// entry_reservations_code_shape. Duplicated here deliberately - if the two ever
// disagree the generator produces codes the database rejects, and this is the
// assertion that catches it before an insert does.
const DB_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}$/;

describe("generateReferenceCode", () => {
  test("every generated code satisfies the database CHECK", () => {
    for (let i = 0; i < 3000; i++) {
      const c = generateReferenceCode();
      assert.match(c, DB_SHAPE, `generated ${c}, which the CHECK would reject`);
    }
  });

  test("never emits an ambiguous glyph", () => {
    // THE PRECONDITION FOR THE NORMALISER. I, L and O in a typed query can only
    // ever be a misread, because they are never produced.
    for (let i = 0; i < 3000; i++) {
      assert.doesNotMatch(generateReferenceCode(), /[ILOU]/);
    }
  });

  test("is five characters", () => {
    assert.equal(generateReferenceCode().length, CODE_LENGTH);
  });

  // Not a uniqueness proof - the database owns that per board - but a generator
  // stuck on one value or one leading character would show up here.
  test("uses the whole alphabet and does not repeat itself", () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const c = generateReferenceCode();
      seen.add(c);
      for (const ch of c) chars.add(ch);
    }
    assert.ok(seen.size > 3900, `only ${seen.size} distinct codes in 4000 draws`);
    assert.equal(chars.size, 32, "every symbol in the alphabet should appear");
  });
});

describe("normalizeReferenceCode — the half that makes Crockford worth using", () => {
  test("the ambiguous glyphs map onto their digits", () => {
    assert.equal(normalizeReferenceCode("I2345"), "12345");
    assert.equal(normalizeReferenceCode("L2345"), "12345");
    assert.equal(normalizeReferenceCode("O2345"), "02345");
    assert.equal(normalizeReferenceCode("iloILO"), "110110");
  });

  test("lower case is uppercased", () => {
    assert.equal(normalizeReferenceCode("h82k4"), "H82K4");
  });

  test("whitespace and hyphens are stripped", () => {
    // People group codes when they write them down and when they read them back.
    for (const typed of ["H8 2K4", "H8-2K4", " H82K4 ", "H-8 2-K 4"]) {
      assert.equal(normalizeReferenceCode(typed), "H82K4", `failed on ${typed}`);
    }
  });

  test("a correctly typed code is unchanged", () => {
    assert.equal(normalizeReferenceCode("H82K4"), "H82K4");
  });

  // THE CASE THAT MATTERS. A host squinting at a bank memo types what they see;
  // every one of these must find the same stored code.
  test("every plausible misreading of one stored code normalises to it", () => {
    const stored = "H82K4";
    for (const typed of ["h82k4", "H8 2K4", "h8-2k4", "  H82K4"]) {
      assert.equal(normalizeReferenceCode(typed), stored);
    }
    // And a code that genuinely contains 1 or 0 is reachable from its glyphs.
    assert.equal(normalizeReferenceCode("h1o2k"), "H102K");
    assert.equal(normalizeReferenceCode("HIO2K"), "H102K");
    assert.equal(normalizeReferenceCode("HLO2K"), "H102K");
  });

  test("empty input is empty, not a match-everything query", () => {
    for (const v of ["", "   ", "---", null, undefined]) {
      assert.equal(normalizeReferenceCode(v), "");
    }
  });

  // The mapping is one-directional and must stay that way: nothing normalises
  // INTO a glyph the generator refuses to emit.
  test("normalising never produces an excluded glyph", () => {
    for (let i = 0; i < 500; i++) {
      const c = generateReferenceCode();
      assert.doesNotMatch(normalizeReferenceCode(c.toLowerCase()), /[ILOU]/);
    }
  });
});

describe("looksLikeReferenceCode", () => {
  test("accepts a code however it was typed", () => {
    for (const v of ["H82K4", "h82k4", "H8-2K4", "hio2k"]) {
      assert.equal(looksLikeReferenceCode(v), true, `rejected ${v}`);
    }
  });

  test("rejects input that cannot be a code", () => {
    for (const v of ["Taylor Smith", "Olivia", "H82", "H82K45", "", null]) {
      assert.equal(looksLikeReferenceCode(v), false, `accepted ${v}`);
    }
  });

  // THE TRAP. The normaliser folds letters onto digits, so a five-letter name
  // built from the allowed glyphs comes out code-shaped. This is NOT a bug in
  // the predicate - it is why the predicate must never be used to choose
  // BETWEEN a code search and a name search.
  test("real names normalise to code shapes, which is exactly the hazard", () => {
    assert.equal(normalizeReferenceCode("Holly"), "H011Y");
    assert.equal(normalizeReferenceCode("Molly"), "M011Y");
    assert.equal(looksLikeReferenceCode("Holly"), true);
    assert.equal(looksLikeReferenceCode("Molly"), true);
  });

  test("every generated code is recognised as one", () => {
    for (let i = 0; i < 1000; i++) {
      assert.equal(looksLikeReferenceCode(generateReferenceCode()), true);
    }
  });
});

describe("reservationSearchTerms — the code lookup is additive, never a branch", () => {
  // THE REGRESSION. Branching on looksLikeReferenceCode would send a host
  // searching for Holly into a code lookup that finds nothing, and never search
  // the names at all. She is a real contributor and she must be findable.
  test("a name that is code-shaped still searches by name", () => {
    for (const name of ["Holly", "Molly"]) {
      const t = reservationSearchTerms(name);
      assert.equal(t.text, name, "the RAW input drives the name and email match");
      assert.notEqual(t.code, null, "and the code lookup runs as well, not instead");
    }
  });

  test("the text term is never the normalised form", () => {
    // If `text` were normalised, a search for Holly would look for H011Y in the
    // name column and find nobody.
    const t = reservationSearchTerms("Holly");
    assert.notEqual(t.text, "H011Y");
    assert.equal(t.text, "Holly");
  });

  test("an ordinary name runs the text search and no code lookup", () => {
    const t = reservationSearchTerms("Taylor Smith");
    assert.equal(t.text, "Taylor Smith");
    assert.equal(t.code, null, "no point querying a column it cannot match");
  });

  test("a typed code searches both, normalised only on the code side", () => {
    const t = reservationSearchTerms("h8-2k4");
    assert.equal(t.text, "h8-2k4", "raw, so a name containing it still matches");
    assert.equal(t.code, "H82K4");
  });

  test("surrounding whitespace is trimmed from the text term", () => {
    assert.equal(reservationSearchTerms("  Holly  ").text, "Holly");
  });

  test("empty input yields no code lookup", () => {
    for (const v of ["", "   ", null, undefined]) {
      const t = reservationSearchTerms(v);
      assert.equal(t.text, "");
      assert.equal(t.code, null);
    }
  });
});
