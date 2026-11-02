"""On-demand summaries. The Hugging Face model is mocked; these tests do not download it."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import index  # noqa: E402
import summarize  # noqa: E402


def post(body):
    raw = body if isinstance(body, str) else json.dumps(body)
    code, obj, *_ = index.route("POST", "/api/summarize", "", raw, {})
    return code, obj


class SummarizeRouteTests(unittest.TestCase):
    def test_rejects_bad_input(self):
        self.assertEqual(post("not json")[0], 400)
        self.assertEqual(post({})[0], 400)
        self.assertEqual(post({"text": "too short"})[0], 400)
        self.assertEqual(post({"text": 12})[0], 400)
        self.assertEqual(post({"text": "x" * 4001})[0], 400)

    def test_returns_the_model_summary(self):
        found = {"summary": "Models agree on this result.", "model": summarize.MODEL_ID}
        with mock.patch.object(index.summarize, "summarize", return_value=found) as call:
            code, obj = post({"text": "The simple model says no diabetes, with a 20% chance."})
        self.assertEqual(code, 200)
        self.assertEqual(obj, found)
        call.assert_called_once()

    def test_passes_a_question(self):
        found = {"summary": "The simple model says diabetes.", "model": "m"}
        with mock.patch.object(index.summarize, "summarize", return_value=found) as call:
            code, obj = post({"text": "The simple model says diabetes, with a 72% chance.",
                              "question": "What does the simple model say?"})
        self.assertEqual((code, obj), (200, found))
        self.assertEqual(call.call_args.args[1], "What does the simple model say?")

    def test_rejects_a_bad_question(self):
        text = "The simple model says diabetes, with a 72% chance."
        self.assertEqual(post({"text": text, "question": 12})[0], 400)
        self.assertEqual(post({"text": text, "question": "x" * 301})[0], 400)

    def test_missing_library_is_unavailable(self):
        with mock.patch.object(index.summarize, "summarize",
                                side_effect=RuntimeError("not installed")):
            code, obj = post({"text": "The simple model says no diabetes, with a 20% chance."})
        self.assertEqual(code, 503)
        self.assertIn("not installed", obj["error"])


class SummarizeTextTests(unittest.TestCase):
    """With the model installed (mocked)."""

    def setUp(self):
        patch = mock.patch.object(summarize, "available", return_value=True)
        patch.start()
        self.addCleanup(patch.stop)

    def test_keeps_a_faithful_two_sentence_draft(self):
        source = ("The simple model says diabetes, with a 72% chance of diabetes. "
                  "Other good models range from 61% to 84%.")
        draft = ("The simple model says diabetes, with a 72% chance. "
                 "Other good models range from 61% to 84%. Extra sentence here.")
        with mock.patch.object(summarize, "_generate", return_value=draft):
            out = summarize.summarize(source)
        self.assertEqual(out["model"], summarize.MODEL_ID)
        self.assertEqual(
            out["summary"],
            "The simple model says diabetes, with a 72% chance. "
            "Other good models range from 61% to 84%.")

    def test_a_short_label_does_not_use_up_a_sentence(self):
        text = ("You. The simple model says diabetes, with a 72% chance. "
                "Other models range from 61% to 84%.")
        self.assertEqual(summarize._two_sentences(text), text)

    def test_drops_a_draft_that_adds_facts(self):
        source = ("The simple model says diabetes, with a 72% chance of diabetes. "
                  "Other good models range from 61% to 84%.")
        bad = "Glucose is the most common form of diabetes. It affects most people."
        with mock.patch.object(summarize, "_generate", return_value=bad):
            out = summarize.summarize(source)
        self.assertIsNone(out["model"])
        self.assertEqual(out["summary"], " ".join(source.split()))

    def test_answers_from_the_result(self):
        source = "The simple model says diabetes, with a 72% chance of diabetes."
        draft = "The simple model says diabetes, with a 72% chance."
        with mock.patch.object(summarize, "_generate", return_value=draft):
            out = summarize.summarize(source, "What does the simple model say?")
        self.assertEqual(out["model"], summarize.MODEL_ID)
        self.assertIn("72%", out["summary"])

    def test_drops_an_answer_that_invents_numbers(self):
        source = "The simple model says diabetes, with a 72% chance of diabetes."
        bad = "About 10% of people with glucose over 200 develop diabetes."
        with mock.patch.object(summarize, "_generate", return_value=bad):
            out = summarize.summarize(source, "How common is this?")
        self.assertIsNone(out["model"])
        self.assertIn("can’t be answered", out["summary"])


class NoModelTests(unittest.TestCase):
    """The hosted site has no model: summaries and answers still work."""
    BRIEF = ("Sample person 506. The simple model predicts Diabetes, with a 73% chance of "
             "Diabetes. Other good models range from 61% to 84%. The good models agree. "
             "The values that push the simple model most are Glucose, BMI.")

    def setUp(self):
        patch = mock.patch.object(summarize, "available", return_value=False)
        patch.start()
        self.addCleanup(patch.stop)

    def test_summary_is_the_pages_own_wording(self):
        code, obj = post({"text": self.BRIEF})
        self.assertEqual(code, 200)
        self.assertEqual((obj["summary"], obj["source"]), (self.BRIEF, "page"))

    def test_answers_a_question_about_the_range(self):
        code, obj = post({"text": self.BRIEF, "question": "What does the uncertainty range mean?"})
        self.assertEqual((code, obj["source"]), (200, "built-in"))
        self.assertIn("fit the data about as well", obj["summary"])
        self.assertIn("61% to 84%", obj["summary"])            # quotes this result

    def test_answers_what_drove_it(self):
        out = summarize.explain(self.BRIEF, "Why did it say that?")
        self.assertIn("Glucose, BMI", out)

    def test_advice_questions_get_the_not_advice_answer(self):
        out = summarize.explain(self.BRIEF, "Should I take insulin to lower the chance?")
        self.assertIn("not a diagnosis", out)

    def test_off_topic_question_is_declined(self):
        out = summarize.explain(self.BRIEF, "What is the capital of France?")
        self.assertIn("can’t be answered", out)

    def test_page_can_tell_before_asking(self):
        code, obj, *_ = index.route("GET", "/api/summarize", "", None, {})
        self.assertEqual((code, obj["ai"]), (200, False))


if __name__ == "__main__":
    unittest.main()
