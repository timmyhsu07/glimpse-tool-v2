import importlib.util
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class VercelConfigTests(unittest.TestCase):
    """One Python function serves the API and the frontend files."""

    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((ROOT / "vercel.json").read_text())

    def test_python_preset_sends_every_request_to_the_function(self):
        # The preset builds one function from pyproject's entrypoint and routes all
        # paths to it; the handler serves the API and frontend/ itself.
        self.assertEqual(self.config["framework"], "python")
        self.assertNotIn("outputDirectory", self.config)

    def test_function_bundles_the_backend_and_frontend(self):
        fn = self.config["functions"]["api/index.py"]
        for part in ("backend/api", "backend/engine", "frontend"):
            self.assertIn(part, fn["includeFiles"])

    def test_pyproject_entrypoint_matches(self):
        self.assertIn('entrypoint = "api.index:handler"',
                      (ROOT / "pyproject.toml").read_text())

    def test_bundled_paths_exist(self):
        for rel in ("api/index.py", "backend/api/index.py", "backend/engine/precomputed",
                    "frontend/index.html", "frontend/login.html", "frontend/tutorial.html",
                    "frontend/eclipse.html", "frontend/details.html"):
            self.assertTrue((ROOT / rel).exists(), rel)

    def test_tutorial_routes_preserve_the_old_how_urls(self):
        static = _load_entry()._backend._STATIC
        self.assertEqual(static["/tutorial.html"][0], "tutorial.html")
        self.assertEqual(static["/tutorial"][0], "tutorial.html")
        self.assertEqual(static["/how.html"][0], "tutorial.html")
        self.assertEqual(static["/how"][0], "tutorial.html")

    def test_details_route_serves_the_details_page(self):
        static = _load_entry()._backend._STATIC
        self.assertEqual(static["/details.html"][0], "details.html")
        self.assertEqual(static["/details"][0], "details.html")

    def test_colour_choices_survive_restyles(self):
        # every page applies the saved colour set, My account offers the picker, and the
        # stylesheet has the sets and the dashed legend swatch
        for page in sorted((ROOT / "frontend").glob("*.html")):
            self.assertIn("glimpse-palette", page.read_text(), page.name)
        self.assertIn('id="palette-picker"', (ROOT / "frontend/account.html").read_text())
        css = (ROOT / "frontend/style.css").read_text()
        for name in ("blue-red", "green-purple", "classic"):
            self.assertIn(f'[data-palette="{name}"]', css)
        self.assertIn(".sw.line.dash", css)

    def test_pages_share_one_menu_and_link_the_tutorial(self):
        menus = set()
        for page in sorted((ROOT / "frontend").glob("*.html")):
            html = page.read_text()
            self.assertNotIn("how.html", html, page.name)
            nav = html[html.index('<nav id="nav"'):html.index("</nav>")]
            menus.add(" ".join(re.findall(r'href="([^"]+)"', nav)))
        self.assertEqual(menus, {"/ /app.html /tutorial.html /compare.html"})

    def test_entered_values_stay_out_of_links(self):
        app = (ROOT / "frontend" / "app.js").read_text()
        self.assertNotIn("encodeYou", app)
        self.assertIn("sessionStorage.setItem(HANDOFF_KEY", app)

    def test_results_say_whose_data_and_what_it_means(self):
        for page in ("app.html", "details.html"):
            html = (ROOT / "frontend" / page).read_text()
            self.assertIn('id="verdict-limits"', html)
            self.assertNotIn("Safest change", html)
        self.assertNotIn(">Find me<", (ROOT / "frontend" / "app.html").read_text())

    def test_entry_point_exposes_the_backend_handler(self):
        entry = _load_entry()
        self.assertIs(entry.handler, entry._backend.handler)
        self.assertTrue(hasattr(entry.handler, "do_POST"))

    def test_rewritten_path_routes_like_the_original(self):
        route = _load_entry()._backend.route
        self.assertEqual(route("GET", "/api/index", "__route=health", None)[0], 200)
        self.assertEqual(route("GET", "/api/index", "__route=nope", None)[0], 404)


def _load_entry():
    spec = importlib.util.spec_from_file_location("index", ROOT / "api" / "index.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


if __name__ == "__main__":
    unittest.main()
