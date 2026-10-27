-- Merch buyer questions: up to 5 instead of 2 (spec Revision 3.8, §3 and §5.6.1).
-- Loosens one CHECK on daali_merch_listings. Every existing row has 2 or fewer
-- questions, so it satisfies the new check. No table, column, grant, RLS or
-- policy change. Forward-only: returning to 2 is possible only while no listing
-- has more than 2 questions.

ALTER TABLE "daali_merch_listings" DROP CONSTRAINT "daali_merch_listings_questions_max2";

ALTER TABLE "daali_merch_listings" ADD CONSTRAINT "daali_merch_listings_questions_max5"
  CHECK (jsonb_typeof("questions") = 'array' AND jsonb_array_length("questions") <= 5);
