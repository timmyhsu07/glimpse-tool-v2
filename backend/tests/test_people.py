"""Fast predictions for entered people, and save renaming / listing."""
import json
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

import index  # noqa: E402
from test_auth import AuthTests, call, session_cookie  # noqa: E402


def people(body):
    code, obj, *_ = index.route("POST", "/api/people", "", json.dumps(body), {})
    return code, obj


class PeopleTests(unittest.TestCase):
    def test_matches_the_scene_verdict(self):
        custom = {"Glucose": 150, "BMI": 31.5}
        code, out = people({"dataset": "pima", "people": [custom, {}]})
        self.assertEqual(code, 200)
        _, scene = index.route("POST", "/api/scene", "",
                               json.dumps({"dataset": "pima", "custom": custom}), {})
        me = out["people"][0]
        for key in ("linear", "mlp"):
            m = scene["panels"][key]["metrics"]
            self.assertAlmostEqual(me[key]["p"], m["p_bad_erm_x0"], places=3)
            self.assertAlmostEqual(me[key]["lo"], m["p_bad_best_x0"], places=3)
            self.assertAlmostEqual(me[key]["hi"], m["p_bad_worst_x0"], places=3)
        json.dumps(out)                                        # plain JSON types only
        self.assertAlmostEqual(me["x"], scene["query"]["x"], places=6)
        self.assertEqual(me["provided"], ["Glucose", "BMI"])
        self.assertEqual(out["people"][1]["provided"], [])          # all typical values
        self.assertEqual(len(out["importance"]), len(out["features"]))

    def test_rejects_bad_input(self):
        self.assertEqual(people({"dataset": "nope", "people": [{}]})[0], 400)
        self.assertEqual(people({"dataset": "pima", "people": []})[0], 400)
        self.assertEqual(people({"dataset": "pima", "people": [{}] * 61})[0], 400)
        self.assertEqual(people({"dataset": "pima", "people": [{"Glucose": "nan"}]})[0], 400)
        self.assertEqual(people({"dataset": "pima", "people": [{"Glucose": True}]})[0], 400)

    def test_scene_has_quick_and_safe_changes(self):
        _, scene = index.route("GET", "/api/scene", "dataset=pima", None, {})
        row = scene["deltas"][0]
        for key in ("linear", "mlp", "linear_quick", "mlp_quick"):
            self.assertIn("cf_real", row[key])


def scene(body):
    code, obj, *_ = index.route("POST", "/api/scene", "", json.dumps(body), {})
    return code, obj


class ImpossibleValueTests(unittest.TestCase):
    def test_negative_glucose_gets_no_prediction(self):
        code, obj = scene({"dataset": "pima", "custom": {"Glucose": -20}})
        self.assertEqual(code, 400)
        self.assertEqual(obj["invalid"][0]["name"], "Glucose")
        self.assertIn("more than 0", obj["error"])
        self.assertEqual(people({"dataset": "pima", "people": [{"Glucose": -20}]})[0], 400)

    def test_zero_means_not_measured_so_it_is_refused(self):
        self.assertEqual(scene({"dataset": "pima", "custom": {"BMI": 0}})[0], 400)
        self.assertEqual(scene({"dataset": "pima", "custom": {"Pregnancies": 0}})[0], 200)

    def test_counts_are_whole(self):
        code, obj = scene({"dataset": "pima", "custom": {"Pregnancies": 1.5}})
        self.assertEqual(code, 400)
        self.assertIn("whole number", obj["error"])

    def test_values_read_back_from_the_data_pass(self):
        # typical values come back with float32 noise, e.g. 2.9999998 pregnancies
        code, _ = scene({"dataset": "pima", "custom": {"Pregnancies": 3.0000001, "Age": -1e-7 + 30}})
        self.assertEqual(code, 200)
        _, typical = scene({"dataset": "pima", "custom": {}})
        values = {r["name"]: r["x0_real"] for r in typical["deltas"]}
        self.assertEqual(scene({"dataset": "pima", "custom": values})[0], 200)

    def test_negative_tumor_measure_is_refused(self):
        self.assertEqual(scene({"dataset": "cancer", "custom": {"mean radius": -3}})[0], 400)

    def test_unusual_but_possible_value_is_flagged_not_refused(self):
        code, obj = scene({"dataset": "pima", "custom": {"Glucose": 250}})
        self.assertEqual(code, 200)
        self.assertEqual(obj["query"]["outside"], ["Glucose"])

    def test_a_map_spot_may_stand_for_values_nobody_has(self):
        code, obj = scene({"dataset": "pima", "custom": {"Glucose": -20}, "from_map": True})
        self.assertEqual(code, 200)
        self.assertTrue(obj["query"]["from_map"])
        self.assertEqual(obj["query"]["impossible"], ["Glucose"])
        code, _ = people({"dataset": "pima", "people": [{"Glucose": -20}], "from_map": True})
        self.assertEqual(code, 200)

    def test_form_gets_the_same_rules(self):
        _, obj = scene({"dataset": "pima", "custom": {}})
        f = {x["name"]: x for x in obj["features"]}
        self.assertEqual((f["Glucose"]["possible_min"], f["Glucose"]["above_min"]), (0.0, True))
        self.assertTrue(f["Pregnancies"]["whole"])
        self.assertFalse(f["Age"]["above_min"])


class SaveListTests(AuthTests):
    def test_rename_and_list_every_topic(self):
        ck = session_cookie(self.register()[2])
        ids = [call("POST", "/api/saved", {"dataset": ds, "name": n, "values": {"x": 1}},
                    cookie=ck)[1]["saved"]["id"] for ds, n in (("pima", "a"), ("pima", "b"),
                                                               ("cancer", "a"))]
        code, obj, _ = call("GET", "/api/saved", cookie=ck)
        self.assertEqual(code, 200)
        self.assertEqual(sorted(e["dataset"] for e in obj["saved"]), ["cancer", "pima", "pima"])
        self.assertEqual(call("POST", "/api/saved/rename", {"id": ids[0], "name": "b"},
                              cookie=ck)[0], 409)
        code, obj, _ = call("POST", "/api/saved/rename", {"id": ids[0], "name": "  May  "},
                            cookie=ck)
        self.assertEqual((code, obj["name"]), (200, "May"))
        other = session_cookie(self.register(email="eve@example.com")[2])
        self.assertEqual(call("POST", "/api/saved/rename", {"id": ids[0], "name": "x"},
                              cookie=other)[0], 404)


del AuthTests



class SafeChangeTests(unittest.TestCase):
    """A "safe change" is only offered when every good model is convinced."""

    def test_safe_ok_matches_the_worst_case_margin(self):
        for ds in ("pima", "cancer"):
            _, scene = index.route("GET", "/api/scene", f"dataset={ds}", None, {})
            for key in ("linear", "mlp"):
                m = scene["panels"][key]["metrics"]
                self.assertEqual(m["safe_ok"], m["robust_margin_cf"] >= 0.1 - 1e-3, (ds, key))

    def test_suggested_values_stay_within_what_the_data_has_seen(self):
        for ds in ("pima", "cancer"):
            _, out = people({"dataset": ds, "people": [{}]})
            feats = {f["name"]: f for f in out["features"]}
            _, scene = index.route("GET", "/api/scene", f"dataset={ds}", None, {})
            for r in scene["deltas"]:
                f = feats[r["name"]]
                lo, hi = min(f["min"], r["x0_real"]), max(f["max"], r["x0_real"])
                for key in ("linear", "mlp", "linear_quick", "mlp_quick"):
                    v = r[key]["cf_real"]
                    self.assertTrue(lo - 1e-3 <= v <= hi + 1e-3, (ds, r["name"], key, v))

    def test_every_model_says_whether_its_changes_work(self):
        _, scene = index.route("GET", "/api/scene", "dataset=cancer", None, {})
        for key in ("linear", "mlp"):
            m = scene["panels"][key]["metrics"]
            self.assertIn("quick_ok", m)
            self.assertTrue(m["quick_ok"])

    def test_each_change_says_how_much_of_it_the_map_shows(self):
        _, scene = index.route("GET", "/api/scene", "dataset=pima", None, {})
        for key in ("linear", "mlp"):
            m = scene["panels"][key]["metrics"]
            for f in ("quick_on_map", "safe_on_map"):
                self.assertTrue(0.0 <= m[f] <= 1.0, (key, f))

    def test_site_offers_diabetes_and_cancer_only(self):
        _, out = index.route("GET", "/api/datasets", "", None, {})
        self.assertEqual([d["key"] for d in out["datasets"]], ["pima", "cancer"])
        for gone in ("heloc", "taiwan"):
            self.assertEqual(index.route("GET", "/api/scene", f"dataset={gone}", None, {})[0], 400)




class RuleTests(unittest.TestCase):
    """Per-value rules: can't change, only up, only down, free."""

    def scene(self, rules=None, custom=None):
        body = {"dataset": "pima", "custom": custom or {"Glucose": 170, "BMI": 38}}
        if rules is not None:
            body["rules"] = rules
        code, out, *_ = index.route("POST", "/api/scene", "", json.dumps(body), {})
        return code, out

    def row(self, out, name):
        return next(r for r in out["deltas"] if r["name"] == name)

    def test_defaults_lock_the_topics_fixed_values(self):
        _, out = self.scene()
        self.assertEqual(self.row(out, "DiabetesPedigreeFunction")["rule"], "fixed")
        self.assertEqual(self.row(out, "Glucose")["rule"], "free")

    def test_one_way_values_only_go_up_by_default(self):
        # Age and pregnancies can only go up (monotonic); a suggestion never lowers them.
        _, out = self.scene(custom={"Glucose": 170, "BMI": 38, "Age": 45, "Pregnancies": 6})
        for name in ("Age", "Pregnancies"):
            row = self.row(out, name)
            self.assertEqual(row["rule"], "up")
            for key in ("linear", "mlp", "linear_quick", "mlp_quick"):
                self.assertGreaterEqual(row[key]["cf_real"], row["x0_real"] - 1e-3, (name, key))
        feats = {f["name"]: f for f in out["features"]}
        self.assertEqual(feats["Age"]["monotone"], "up")
        self.assertFalse(feats["Age"]["immutable"])

    def test_fewest_changes_touches_fewest_values_and_still_works(self):
        for custom in ({"Glucose": 170, "BMI": 38}, {"Glucose": 150, "BMI": 33, "Insulin": 200}):
            _, out = self.scene(custom=custom)
            for key in ("linear", "mlp"):
                m = out["panels"][key]["metrics"]
                if not m["pred_bad"]:
                    continue
                self.assertTrue(m["sparse_ok"], key)
                self.assertLess(m["p_bad_sparse"], 0.5, key)            # flips the model
                self.assertLessEqual(m["n_sparse"], m["n_quick"], key)  # never more values
                moved = [r["name"] for r in out["deltas"] if abs(r[key + "_sparse"]["delta_std"]) > 1e-6]
                self.assertLessEqual(len(moved), 3, key)
                self.assertNotIn("DiabetesPedigreeFunction", moved)     # locked stays put
                for r in out["deltas"]:
                    if r["rule"] == "up":
                        self.assertGreaterEqual(r[key + "_sparse"]["cf_real"], r["x0_real"] - 1e-3)

    def test_what_drove_it_adds_up_and_covers_every_good_model(self):
        _, out = self.scene()
        for key in ("linear", "mlp"):
            d = out["drivers"][key]
            pushes = [r["push"] for r in d["rows"]]
            self.assertEqual(pushes, sorted(pushes, key=lambda v: -abs(v)))   # biggest first
            for r in d["rows"]:
                self.assertLessEqual(r["lo"], r["push"] + 1e-9)
                self.assertGreaterEqual(r["hi"], r["push"] - 1e-9)
            # pushes add up to this person's score minus an average person's
            p = out["panels"][key]["metrics"]["p_bad_erm_x0"]
            score = math.log(p / (1 - p))
            self.assertAlmostEqual(sum(pushes) + d["base"], score, delta=0.02)

    def test_only_up_and_only_down_are_respected(self):
        _, free = self.scene()
        start = self.row(free, "Glucose")["x0_real"]
        # Lowering glucose is the natural fix, so "only up" must stop it going down.
        self.assertLess(self.row(free, "Glucose")["linear"]["cf_real"], start - 1)
        _, up = self.scene({"Glucose": "up"})
        for key in ("linear", "mlp", "linear_quick", "mlp_quick"):
            self.assertGreaterEqual(self.row(up, "Glucose")[key]["cf_real"], start - 1e-3, key)
        _, down = self.scene({"BMI": "down"})
        b0 = self.row(down, "BMI")["x0_real"]
        for key in ("linear", "mlp", "linear_quick", "mlp_quick"):
            self.assertLessEqual(self.row(down, "BMI")[key]["cf_real"], b0 + 1e-3, key)

    def test_fixed_and_unlocking(self):
        _, out = self.scene({"Glucose": "fixed", "Age": "free"})
        g = self.row(out, "Glucose")
        self.assertTrue(g["immutable"])
        self.assertAlmostEqual(g["linear"]["cf_real"], g["x0_real"], places=3)
        self.assertEqual(self.row(out, "Age")["rule"], "free")

    def test_bad_rules_are_refused(self):
        self.assertEqual(self.scene({"Glucose": "sideways"})[0], 400)
        code, *_ = index.route("GET", "/api/scene", "dataset=pima&rules=notjson", None, {})
        self.assertEqual(code, 400)

    def test_site_map_is_pca(self):
        _, out = self.scene()
        self.assertEqual(out["lens"]["key"], "pca")


if __name__ == "__main__":
    unittest.main()
