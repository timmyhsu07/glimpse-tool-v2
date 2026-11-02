"""Build the linear and MLP counterfactual views as JSON."""
import sys
from itertools import combinations

import numpy as np
from contourpy import contour_generator


import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import LOADERS, DATASET_CHOICES, evaluate
from counterfactuals import train_logreg, RashomonEllipsoid, _sigmoid
from lenses import disagreement, fit_eclipse, fit_pca
from mlp_backend import MLPBackend

N_SCATTER = 600
N_FAN = 40
FIELD_RES = 90
CONTOUR_RES = 400
FAN_RES = 150
MLP_HIDDEN = 16

TARGET_CLASS = 0
MARGIN = 0.10

# Features held fixed during the counterfactual search.
IMMUTABLE = {
    "pima": {"DiabetesPedigreeFunction"},
    "heloc": {"MSinceOldestTradeOpen", "AverageMInFile",
              "ExternalRiskEstimate"},
    "cancer": set(),
    "taiwan": {"x2", "x3", "x4"},                # sex, education, marriage
}

# Values that can only move one way (monotonic): the default "only up" / "only down"
# rules. A suggestion never moves them the other way.
MONOTONE = {
    "pima": {"Pregnancies": "up", "Age": "up"},
    "taiwan": {"x5": "up"},                      # age
}

# The range a living person can have, wider than the data on purpose: a value outside
# it is refused, one inside it but outside the data only gets a warning.
LIMITS = {
    "pima": {
        "Pregnancies": (0, 30),
        "Glucose": (10, 3000),             # mg/dL, 2 hours into a glucose test
        "BloodPressure": (10, 300),        # diastolic, mm Hg
        "SkinThickness": (1, 150),         # triceps skin fold, mm
        "Insulin": (0, 5000),              # µU/mL
        "BMI": (6, 260),
        "DiabetesPedigreeFunction": (0, 10),
        "Age": (0, 122),
    },
}

# Values that must be above zero, not just at least zero. In Pima a stored 0 means
# "not measured", so nobody really has it.
POSITIVE = {
    "pima": {"Insulin"},
}

# Without a known limit, values this many times past the data's largest (or below its
# smallest) are refused.
FAR_BEYOND = 3

_MODELS = {}
_LENSES = {}
_VIEWS = {}

# The topics the site offers, in order. Credit (heloc) and Taiwan credit default are off
# the site for now; Taiwan's data and saved model stay, so adding "taiwan" back here
# (and to the tests) brings it back.
APP_TOPICS = ("pima", "cancer")
DATASETS = sorted((d for d in DATASET_CHOICES if d["key"] in APP_TOPICS),
                  key=lambda d: APP_TOPICS.index(d["key"]))


def _models(dataset_key, eps):
    key = (dataset_key, round(float(eps), 6))
    if key in _MODELS:
        return _MODELS[key]
    data = LOADERS[dataset_key]()

    lin = train_logreg(data.X, data.y)
    lin_ell = RashomonEllipsoid(data.X, lin.theta, eps=eps)
    lin_acc, lin_auc = evaluate(lin, data.X, data.y)

    mlp = MLPBackend(data.X, data.y, eps=eps, hidden=MLP_HIDDEN)
    mlp_acc, mlp_auc = evaluate(mlp, data.X, data.y)

    immutable = IMMUTABLE.get(dataset_key, set()) & set(data.feature_names)
    features = []
    for f in data.feature_meta():
        f = dict(f)
        f["immutable"] = f["name"] in immutable
        features.append(f)

    fixed = np.array([n in immutable for n in data.feature_names], dtype=bool)

    m = dict(data=data, lin=lin, lin_ell=lin_ell, lin_acc=lin_acc,
             lin_auc=lin_auc, mlp=mlp, mlp_acc=mlp_acc, mlp_auc=mlp_auc,
             features=features, immutable=immutable, fixed=fixed,
             median_std=np.median(data.X, axis=0).astype(float))
    _MODELS[key] = m
    return m


# Which map the site draws: "pca" or "eclipse". Switched to PCA on 2026-10-14.
# ECLIPSE stays available as the developer option (``lens="eclipse"``); both fit in
# well under a second, so neither needs to be precomputed.
MAP_LENS = "pca"
_LENS_FIT = {"pca": fit_pca, "eclipse": fit_eclipse}
LENSES = tuple(_LENS_FIT)


def _lens(dataset_key, eps, kind=None):
    kind = kind or MAP_LENS
    key = (dataset_key, round(float(eps), 6), kind)
    if key not in _LENSES:
        m = _models(dataset_key, eps)
        _LENSES[key] = _LENS_FIT[kind](m["data"], m["lin"], m["lin_ell"])
    return _LENSES[key]


def _actions(dataset_key, m):
    """The topic's default rules from IMMUTABLE and MONOTONE. Read here rather than
    from a saved fit, so changing them needs no refit."""
    names = [str(n) for n in m["data"].feature_names]
    immutable = IMMUTABLE.get(dataset_key, set()) & set(names)
    monotone = {n: r for n, r in MONOTONE.get(dataset_key, {}).items()
                if n in names and n not in immutable}
    features = [dict(f, immutable=f["name"] in immutable, monotone=monotone.get(f["name"]),
                     **_possible(dataset_key, f))
                for f in m["features"]]
    return dict(immutable=immutable, monotone=monotone, features=features,
                fixed=np.array([n in immutable for n in names], dtype=bool))


def _possible(dataset_key, f):
    """The values a real person can have, as opposed to the ones seen in the data:
    the LIMITS range when there is one, else nothing negative when the data has no
    negatives, percentages up to 100, nothing far outside the data, whole counts,
    and 0 or 1 for a one-hot column."""
    if f.get("group"):
        return {"possible_min": 0.0, "possible_max": 1.0, "above_min": False, "whole": True}
    whole = f.get("unit") in ("count", "code")
    lim = LIMITS.get(dataset_key, {}).get(f["name"])
    if lim:
        lo, hi = map(float, lim)
    else:
        lo = None if f["min"] < -1e-6 else _round(f["min"] / FAR_BEYOND, up=False) if f["min"] > 1e-6 else 0.0
        hi = 100.0 if f.get("unit") == "%" else _round(FAR_BEYOND * f["max"]) if f["max"] > 0 else None
    return {"possible_min": lo, "possible_max": hi,
            "above_min": f["name"] in POSITIVE.get(dataset_key, ()), "whole": whole}


def _round(x, up=True):
    """x rounded outward to two significant figures, so the limit reads cleanly."""
    step = 10.0 ** (np.floor(np.log10(x)) - 1)
    n = np.ceil(x / step - 1e-9) if up else np.floor(x / step + 1e-9)
    return round(float(n * step), 10)


def impossible_values(dataset_key, custom, eps=0.03):
    """Entered values no real person could have: [{name, label, value, reason}]."""
    setup = _setup(dataset_key, float(np.clip(eps, 0.005, 0.2)))
    out = []
    for f in setup["features"]:
        v = custom.get(f["name"])
        if v is None or v == "":
            continue
        v, lo, hi = float(v), f["possible_min"], f["possible_max"]
        # small slack: values read back from the data carry float32 noise
        if lo is not None and (v <= lo if f["above_min"] else v < lo - 1e-6):
            reason = f"must be more than {lo:g}" if f["above_min"] else f"can’t be below {lo:g}"
        elif hi is not None and v > hi:
            reason = f"can’t be above {hi:g}"
        elif f["whole"] and abs(v - round(v)) > 1e-4:
            reason = "must be a whole number"
        else:
            continue
        out.append({"name": f["name"], "label": f["label"], "value": v, "reason": reason})
    return out


def _setup(dataset_key, eps, kind=None):
    kind = kind or MAP_LENS
    key = (dataset_key, round(float(eps), 6), kind)
    if key in _VIEWS:
        return _VIEWS[key]

    m = _models(dataset_key, eps)
    lens = _lens(dataset_key, eps, kind)
    data, lin, lin_ell, mlp = m["data"], m["lin"], m["lin_ell"], m["mlp"]

    emb = lens.embed(data.X)
    lo, hi = emb.min(0), emb.max(0)
    pad = 0.08 * (hi - lo)
    lo, hi = lo - pad, hi + pad
    bounds = (lo, hi)

    GXc, GYc, Xc_hi = lens.grid((lo[0], hi[0]), (lo[1], hi[1]), CONTOUR_RES)
    GXf, GYf, Xf_hi = lens.grid((lo[0], hi[0]), (lo[1], hi[1]), FAN_RES)
    H_grid = mlp.embed_h(Xc_hi)
    H_fan = mlp.embed_h(Xf_hi)
    grids = dict(GXc=GXc, GYc=GYc, Xc_hi=Xc_hi, H_grid=H_grid,
                 GXf=GXf, GYf=GYf, Xf_hi=Xf_hi, H_fan=H_fan)

    gx = np.linspace(lo[0], hi[0], FIELD_RES)
    gy = np.linspace(lo[1], hi[1], FIELD_RES)
    GX, GY = np.meshgrid(gx, gy)
    Xfield_hi = lens.invert(np.column_stack([GX.ravel(), GY.ravel()]))
    lin_field = _sigmoid(lin.logit(Xfield_hi)).reshape(FIELD_RES, FIELD_RES)
    mlp_field = mlp.proba(Xfield_hi).reshape(FIELD_RES, FIELD_RES)
    field_axes = dict(x=gx.tolist(), y=gy.tolist())

    if lens.is_linear:
        lin_boundary = [ln for ln in [_theta_line(lens, lin.theta, bounds)]
                        if ln is not None]
        lin_fan = [ln for th in lin_ell.sample_models(N_FAN, random_state=1)
                   if (ln := _theta_line(lens, th, bounds)) is not None]
    else:
        lin_boundary = _contour_lines(GXc, GYc, Xc_hi, lin.theta)
        lin_fan = []
        for th in lin_ell.sample_models(N_FAN, random_state=1):
            lin_fan.extend(_contour_lines(GXf, GYf, Xf_hi, th))

    mlp_boundary = _contour_lines(GXc, GYc, H_grid, mlp.theta)
    mlp_fan = []
    for th in mlp.ell.sample_models(N_FAN, random_state=1):
        mlp_fan.extend(_contour_lines(GXf, GYf, H_fan, th))

    rng = np.random.default_rng(0)
    n = data.n
    scatter_idx = (np.arange(n) if n <= N_SCATTER
                   else rng.choice(n, N_SCATTER, replace=False))

    # Hover cards: each dot's chance under the simple model, the range across
    # the equally-good models, and its values for the two weightiest features.
    Xs = data.X[scatter_idx]
    logit_s = lin.logit(Xs)
    pen_s = logit_s - lin_ell.robust_logit(Xs, 1)
    plain = [j for j, f in enumerate(m["features"]) if not f.get("group")]
    by_weight = sorted(plain, key=lambda j: -abs(lin.w[j]))
    key_j = by_weight[:2]
    scatter_info = dict(p=_sigmoid(logit_s), lo=_sigmoid(logit_s - pen_s),
                        hi=_sigmoid(logit_s + pen_s), key_j=key_j,
                        vals=data.X_real[scatter_idx][:, key_j],
                        importance=[str(data.feature_names[j]) for j in by_weight])

    setup = dict(
        **m, lens=lens, emb=emb, bounds=bounds, eps=float(eps),
        grids=grids, field_axes=field_axes,
        lin_field=lin_field, mlp_field=mlp_field,
        lin_boundary=lin_boundary, lin_fan=lin_fan,
        mlp_boundary=mlp_boundary, mlp_fan=mlp_fan,
        scatter_idx=scatter_idx, scatter_info=scatter_info,
        # Suggested changes stay within what the data has seen (no negative
        # counts, no percentages over 100).
        limits=(data.X.min(axis=0), data.X.max(axis=0)),
    )
    setup.update(_actions(dataset_key, m))
    _VIEWS[key] = setup
    return setup


def _on_map(lens, change):
    size = float(np.linalg.norm(change))
    if size < 1e-9 or not lens.is_linear:
        return 1.0
    return round(float(np.linalg.norm(lens.comp @ change)) / size, 3)


# "Around this person": each model's map rebuilt as a flat slice through the person
# that holds both of that model's suggested changes. The changes show at their true
# distance and direction from the person, and the colour and lines are the models'
# exact answers on the slice (no approximation, unlike the shared map).
VIEWS = ("everyone", "around")
PLANE_RES = 260


def change_plane(setup, x0, panel):
    """Orthonormal 2 x d axes of the slice. The first points at the change the
    map's arrow uses (safe if it works, else quick), the second at the other change.
    When a change is missing or both point the same way, the model's direction and
    the shared map's axes fill in."""
    q, s = panel["_cf_std_full"] - x0, panel["_cf_rob_full"] - x0
    first, second = (s, q) if panel["metrics"]["safe_ok"] else (q, s)
    axes = []
    for v in (first, second, -setup["lin"].w, *setup["lens"].comp):
        v = np.asarray(v, float).copy()
        for a in axes:
            v -= (v @ a) * a
        if np.linalg.norm(v) > 1e-6:
            axes.append(v / np.linalg.norm(v))
        if len(axes) == 2:
            break
    A = np.array(axes)
    if (A @ second)[1] < 0:              # the other change points up
        A[1] *= -1
    return A


def _around(setup, which, x0, panel):
    """Redraw one panel on its slice through x0, in place."""
    A = change_plane(setup, x0, panel)
    decode = lambda Z: np.asarray(Z, float) @ A + x0
    pts = (setup["data"].X[setup["scatter_idx"]] - x0) @ A.T
    std_2d = A @ (panel["_cf_std_full"] - x0)
    rob_2d = A @ (panel["_cf_rob_full"] - x0)
    span = np.vstack([pts, std_2d, rob_2d, np.zeros(2)])
    lo, hi = span.min(0), span.max(0)
    pad = 0.08 * (hi - lo)
    lo, hi = lo - pad, hi + pad

    gx, gy = np.linspace(lo[0], hi[0], FIELD_RES), np.linspace(lo[1], hi[1], FIELD_RES)
    GX, GY = np.meshgrid(gx, gy)
    X_field = decode(np.column_stack([GX.ravel(), GY.ravel()]))
    if which == "linear":
        lin, ell = setup["lin"], setup["lin_ell"]
        field = _sigmoid(lin.logit(X_field))

        def line(th):
            ln = _line_in_box(A @ th[:-1], float(th[:-1] @ x0 + th[-1]), lo, hi)
            return [ln] if ln is not None else []
        boundary = line(lin.theta)
        fan = [ln for th in ell.sample_models(N_FAN, random_state=1) for ln in line(th)]
        worst = line(panel["_theta_w"])
    else:
        mlp = setup["mlp"]
        field = mlp.proba(X_field)

        def grid(res):
            XX, YY = np.meshgrid(np.linspace(lo[0], hi[0], res), np.linspace(lo[1], hi[1], res))
            return XX, YY, mlp.embed_h(decode(np.column_stack([XX.ravel(), YY.ravel()])))
        CX, CY, H = grid(PLANE_RES)
        FX, FY, H_fan = grid(FAN_RES)
        boundary = _contour_lines(CX, CY, H, mlp.theta)
        fan = [ln for th in mlp.ell.sample_models(N_FAN, random_state=1)
               for ln in _contour_lines(FX, FY, H_fan, th)]
        worst = _contour_lines(CX, CY, H, panel["_theta_w"])

    panel.update(
        field={"z": field.reshape(FIELD_RES, FIELD_RES).tolist(), "x": gx.tolist(), "y": gy.tolist()},
        boundary=boundary, fan=fan, worst=worst,
        xy=[[round(float(a), 4), round(float(b), 4)] for a, b in pts],
        bounds={"x": [float(lo[0]), float(hi[0])], "y": [float(lo[1]), float(hi[1])]},
        plane={"origin": [float(v) for v in x0], "axes": A.tolist()},
    )
    panel["cfs"]["standard"].update(x=float(std_2d[0]), y=float(std_2d[1]))
    panel["cfs"]["ellice"].update(x=float(rob_2d[0]), y=float(rob_2d[1]))
    sp = A @ (panel["_cf_sparse_full"] - x0)       # may sit partly off the slice
    panel["cfs"]["sparse"].update(x=float(sp[0]), y=float(sp[1]))
    m = panel["metrics"]
    for key, cf in (("quick_on_map", panel["_cf_std_full"]), ("safe_on_map", panel["_cf_rob_full"])):
        size = float(np.linalg.norm(cf - x0))
        m[key] = 1.0 if size < 1e-9 else round(float(np.linalg.norm(A @ (cf - x0))) / size, 3)
    d_erm = _dist_to_lines(rob_2d, boundary) if boundary else None
    d_worst = _dist_to_lines(rob_2d, worst) if worst else None
    m["d2_cf_to_erm"] = None if d_erm is None else round(d_erm, 4)
    m["d2_cf_to_worst"] = None if d_worst is None else round(d_worst, 4)
    m["worst_closer"] = bool(d_worst is not None and d_erm is not None and d_worst <= d_erm + 1e-9)
    m.update(_drawn_right(setup, which, lambda x: x0 + A.T @ (A @ (x - x0)), x0,
                          panel["_cf_std_full"], panel["_cf_rob_full"],
                          panel["_cf_sparse_full"], panel["_theta_w"]))


def _theta_line(lens, theta, bounds):
    """Return the clipped 2D boundary for a linear lens."""
    a, c0 = lens.linear_logit_coeffs(theta)
    return _line_in_box(a, c0, *bounds)


def _line_in_box(w, b, lo, hi):
    """Segment of {w0*x + w1*y + b = 0} inside the box [lo, hi]."""
    a1, a2, c = float(w[0]), float(w[1]), float(b)
    x0, y0, x1, y1 = float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1])
    pts = []
    for x in (x0, x1):
        if abs(a2) > 1e-12:
            y = -(c + a1 * x) / a2
            if y0 - 1e-9 <= y <= y1 + 1e-9:
                pts.append((x, y))
    for y in (y0, y1):
        if abs(a1) > 1e-12:
            x = -(c + a2 * y) / a1
            if x0 - 1e-9 <= x <= x1 + 1e-9:
                pts.append((x, y))
    uniq = []
    for p in pts:
        if all(abs(p[0] - q[0]) + abs(p[1] - q[1]) > 1e-6 for q in uniq):
            uniq.append(p)
    if len(uniq) < 2:
        return None
    return {"x": [uniq[0][0], uniq[1][0]], "y": [uniq[0][1], uniq[1][1]]}


def _contour_lines(GX, GY, F_grid, theta, level=0.0, max_pts=350):
    """Return contour lines for a model evaluated on a decoded grid."""
    Z = (F_grid @ theta[:-1] + theta[-1]).reshape(GX.shape)
    cg = contour_generator(GX, GY, Z)
    lines = []
    for seg in cg.lines(level):
        step = max(1, len(seg) // max_pts)
        seg = seg[::step]
        lines.append({"x": [float(v) for v in seg[:, 0]],
                      "y": [float(v) for v in seg[:, 1]]})
    return lines


def _dist_to_lines(pt, lines):
    """2D distance from a point to a set of polylines (segment-exact)."""
    best = np.inf
    p = np.asarray(pt, float)
    for ln in lines:
        v = np.column_stack([ln["x"], ln["y"]])
        if len(v) == 1:
            best = min(best, float(np.linalg.norm(v[0] - p)))
            continue
        a, b = v[:-1], v[1:]
        ab = b - a
        t = np.clip(np.einsum("ij,ij->i", p - a, ab) /
                    np.maximum((ab ** 2).sum(1), 1e-18), 0.0, 1.0)
        proj = a + t[:, None] * ab
        best = min(best, float(np.linalg.norm(proj - p, axis=1).min()))
    return best


def _pick_query(setup):
    """Choose a positive example near the fitted boundary."""
    logit = setup["lin"].logit(setup["data"].X)
    cand = np.where((logit > 0.3) & (logit < 2.2))[0]
    if len(cand) == 0:
        return int(np.argmax(logit))
    return int(cand[np.argmin(np.abs(logit[cand] - 1.0))])


def _custom_x0(setup, custom):
    """Standardize entered values and fill blanks with dataset medians."""
    data = setup["data"]
    sc = data.scaler
    x0 = setup["median_std"].copy()
    provided = np.zeros(data.d, dtype=bool)
    for j, name in enumerate(data.feature_names):
        v = custom.get(name)
        if v is None or v == "":
            continue
        x0[j] = (float(v) - float(sc.mean_[j])) / float(sc.scale_[j])
        provided[j] = True
    return x0, provided


def decode_point(dataset_key, point, eps=0.03, plane=None, lens=None):
    """The person the map places at a 2-D position, in real units.

    The map is linear with orthonormal axes, so this is its exact inverse and the
    person lands where the click was. ``plane`` ({origin, axes}, standardized) is a
    panel's slice from the "around this person" view; without it the shared map is used. Values keep six significant digits (well
    under a pixel, even for small-scale features), so whole-number features can
    come back fractional. Also returns the features that fall outside the
    observed data.
    """
    setup = _setup(dataset_key, float(np.clip(eps, 0.005, 0.2)), lens)
    data = setup["data"]
    if plane is None:
        x_std = setup["lens"].invert(np.asarray(point, float).reshape(1, 2))[0]
    else:
        origin, axes = np.asarray(plane["origin"], float), np.asarray(plane["axes"], float)
        if origin.shape != (data.d,) or axes.shape != (2, data.d):
            raise ValueError("'plane' does not match this topic")
        x_std = origin + np.asarray(point, float) @ axes
    real = data.to_real(x_std)
    values, outside = {}, []
    for f, v in zip(setup["features"], real):
        v = float(f"{v:.6g}")
        values[f["name"]] = v
        if not f["min"] <= v <= f["max"]:
            outside.append(f["label"])
    return values, outside


def _percentile(col, v):
    return float(np.mean(col <= v) * 100.0)


RULES = ("fixed", "up", "down", "free")


def _rules(setup, x0, constraints=None):
    """Per-value rules -> (fixed mask, limits, {name: rule}).

    Defaults: the topic's locked values are "fixed", its one-way values "up" or
    "down" (MONOTONE), the rest "free". ``constraints``
    ({name: rule}) overrides them; "up" can't go below the person's value, "down"
    can't go above it. Everything still stays within what the data has seen.
    """
    names = [str(n) for n in setup["data"].feature_names]
    one_way = setup.get("monotone", {})
    rule = {n: ("fixed" if n in setup["immutable"] else one_way.get(n, "free")) for n in names}
    for n, r in (constraints or {}).items():
        if n in rule and r in RULES:
            rule[n] = r
    fixed = np.array([rule[n] == "fixed" for n in names])
    lo, hi = setup["limits"][0].copy(), setup["limits"][1].copy()
    for j, n in enumerate(names):
        if rule[n] == "up":
            lo[j] = max(lo[j], x0[j])
        elif rule[n] == "down":
            hi[j] = min(hi[j], x0[j])
    return fixed, (lo, hi), rule


def _drawn_right(setup, which, decode, x0, cf_std, cf_rob, cf_sparse, theta_w):
    """Does the map draw each point on the side of its line where it really is?

    ``decode`` maps a person to the person the map shows at their spot. On the shared
    map that is a different person (the values the flat map can't show are set to
    typical ones), so a change can land on the wrong side of the drawn line even though
    it works; on the "around this person" slice the person and both changes are exact.
    """
    toward = 1.0 if TARGET_CLASS == 1 else -1.0       # target side: toward * logit > 0
    if which == "linear":
        logit = lambda x: float(setup["lin"].logit(x)[0])
        worst = lambda x: float(np.append(x, 1.0) @ theta_w)
    else:
        mlp = setup["mlp"]
        logit = lambda x: float(mlp.logit(x[None, :])[0])
        worst = lambda x: float(mlp.logit_of_theta(theta_w, x[None, :])[0])
    return {
        "star_drawn_right": bool(np.sign(logit(decode(x0))) == np.sign(logit(x0))),
        "quick_drawn_right": bool(toward * logit(decode(cf_std)) > 0),
        "safe_drawn_right": bool(toward * worst(decode(cf_rob)) > 0),
        "sparse_drawn_right": bool(toward * logit(decode(cf_sparse)) > 0),
    }


SPARSE_MAX = 3      # "fewest changes" looks for a change to at most this many values
SPARSE_POOL = 8     # among this many of the most promising values
CHANGED = 0.05      # a value counts as changed past this (standardized), as on the cards


def _sparse_cf(setup, which, x0, fixed, limits, quick):
    """The change that touches the fewest values, and among those the smallest.

    Tries changing 1, 2, ... SPARSE_MAX values, chosen from the SPARSE_POOL values that
    can push the score furthest toward the target within their limits; each try is the
    model's own smallest change with every other value held. For the simple model a
    set is only tried if it can reach the line at all (exact). Falls back to the quick
    change when no small set works. Returns (change, works).
    """
    lo, hi = limits
    if which == "linear":
        model, w = setup["lin_ell"], setup["lin"].w
        logit = lambda x: float(setup["lin"].logit(x[None, :])[0])
        slope = w
    else:
        model = setup["mlp"]
        logit = lambda x: float(model.logit(x[None, :])[0])
        slope = model._logit_grad(x0)
    need = logit(x0) + MARGIN                      # how far the score has to fall
    if need <= 0:
        return x0.copy(), True
    room = np.where(slope > 0, x0 - lo, hi - x0)   # room to move the helpful way
    push = np.where(fixed, 0.0, np.abs(slope) * np.maximum(room, 0.0))
    pool = [j for j in np.argsort(-push)[:SPARSE_POOL] if push[j] > 1e-9]
    for k in range(1, SPARSE_MAX + 1):
        best, best_d = None, np.inf
        for S in combinations(pool, k):
            if which == "linear" and push[list(S)].sum() < need - 1e-9:
                continue                           # can't reach the line with these
            hold = np.ones(len(x0), dtype=bool)
            hold[list(S)] = False
            cf = model.standard_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=hold | fixed,
                                   limits=limits)
            d = float(np.linalg.norm(cf - x0))
            if -logit(cf) >= MARGIN - 1e-3 and d < best_d:
                best, best_d = cf, d
        if best is not None:
            return best, True
    return quick.copy(), bool(-logit(quick) >= MARGIN - 1e-3)


def _panel(setup, which, x0, fixed=None, limits=None):
    """Build one model panel for a query."""
    lens, bounds = setup["lens"], setup["bounds"]
    g = setup["grids"]
    if fixed is None:
        fixed, limits = setup["fixed"], setup["limits"]

    if which == "linear":
        model, ell = setup["lin"], setup["lin_ell"]
        cf_std = ell.standard_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=fixed, limits=limits)
        cf_rob = ell.robust_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=fixed, limits=limits)
        theta_w = ell.worst_model(cf_rob, TARGET_CLASS)
        if lens.is_linear:
            worst_lines = [ln for ln in [_theta_line(lens, theta_w, bounds)]
                           if ln is not None]
        else:
            worst_lines = _contour_lines(g["GXc"], g["GYc"], g["Xc_hi"], theta_w)
        logit_x0 = float(model.logit(x0)[0])
        logit_cf = float(model.logit(cf_rob)[0])
        logit_std = float(model.logit(cf_std)[0])
        rob_x0 = float(ell.robust_logit(x0, TARGET_CLASS)[0])
        rob_cf = float(ell.robust_logit(cf_rob, TARGET_CLASS)[0])
    else:
        mlp = setup["mlp"]
        cf_std = mlp.standard_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=fixed, limits=limits)
        cf_rob = mlp.robust_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=fixed, limits=limits)
        theta_w = mlp.worst_model(cf_rob, TARGET_CLASS)
        worst_lines = _contour_lines(g["GXc"], g["GYc"], g["H_grid"], theta_w)
        logit_x0 = float(mlp.logit(x0[None, :])[0])
        logit_cf = float(mlp.logit(cf_rob[None, :])[0])
        logit_std = float(mlp.logit(cf_std[None, :])[0])
        rob_x0 = float(mlp.robust_logit(x0[None, :], TARGET_CLASS)[0])
        rob_cf = float(mlp.robust_logit(cf_rob[None, :], TARGET_CLASS)[0])

    cf_sparse, sparse_ok = _sparse_cf(setup, which, x0, fixed, limits, cf_std)
    if which == "linear":
        logit_sparse = float(model.logit(cf_sparse)[0])
        rob_sparse = float(ell.robust_logit(cf_sparse, TARGET_CLASS)[0])
    else:
        logit_sparse = float(mlp.logit(cf_sparse[None, :])[0])
        rob_sparse = float(mlp.robust_logit(cf_sparse[None, :], TARGET_CLASS)[0])
    std_2d = lens.embed(cf_std)[0]
    rob_2d = lens.embed(cf_rob)[0]
    sparse_2d = lens.embed(cf_sparse)[0]
    n_changed = lambda cf: int((np.abs(cf - x0) > CHANGED).sum())

    boundary = setup[f"{'lin' if which == 'linear' else 'mlp'}_boundary"]
    d_erm = _dist_to_lines(rob_2d, boundary)
    d_worst = _dist_to_lines(rob_2d, worst_lines) if worst_lines else None

    pen = max(-(logit_x0 + rob_x0), 0.0)
    metrics = {
        "pred_bad": bool(_sigmoid(logit_x0) >= 0.5),
        "p_bad_erm_x0": _sigmoid(logit_x0),
        "p_bad_best_x0": _sigmoid(logit_x0 - pen),
        "p_bad_worst_x0": _sigmoid(logit_x0 + pen),
        "p_bad_erm_cf": _sigmoid(logit_cf),
        "p_bad_worst_cf": _sigmoid(-rob_cf),
        "robust_margin_x0": rob_x0,
        "robust_margin_cf": rob_cf,
        # False when no allowed change convinces every good model (safe) or even
        # this model (quick); the search then stops at its best attempt.
        "safe_ok": bool(rob_cf >= MARGIN - 1e-3),
        "quick_ok": bool(-logit_std >= MARGIN - 1e-3),
        # How much of each change lands on the flat map (the rest is in values the
        # map can't show), so the page can say when the picture undersells it.
        "quick_on_map": _on_map(lens, cf_std - x0),
        "safe_on_map": _on_map(lens, cf_rob - x0),
        # The three changes listed on the map page: chance after, and values changed.
        "sparse_ok": bool(sparse_ok),
        **_drawn_right(setup, which, lambda x: lens.invert(lens.embed(x))[0],
                       x0, cf_std, cf_rob, cf_sparse, theta_w),
        "sparse_safe": bool(rob_sparse >= MARGIN - 1e-3),
        "p_bad_quick": _sigmoid(logit_std),
        "p_bad_sparse": _sigmoid(logit_sparse),
        "n_quick": n_changed(cf_std),
        "n_sparse": n_changed(cf_sparse),
        "n_safe": n_changed(cf_rob),
        "cost_std": float(np.linalg.norm(cf_std - x0)),
        "cost_rob": float(np.linalg.norm(cf_rob - x0)),
        "already_robust": bool(rob_x0 >= 0),
        "d2_cf_to_erm": d_erm,
        "d2_cf_to_worst": d_worst,
        "worst_closer": bool(d_worst is not None and d_worst <= d_erm + 1e-9),
    }
    metrics = {k: (round(float(v), 4)
                   if isinstance(v, (float, np.floating, np.ndarray)) else v)
               for k, v in metrics.items()}

    return {
        "kind": which,
        "acc": setup[f"{'lin' if which == 'linear' else 'mlp'}_acc"],
        "auc": setup[f"{'lin' if which == 'linear' else 'mlp'}_auc"],
        "field": {"z": setup[f"{'lin' if which == 'linear' else 'mlp'}_field"].tolist(),
                  **setup["field_axes"]},
        "boundary": boundary,
        "fan": setup[f"{'lin' if which == 'linear' else 'mlp'}_fan"],
        "worst": worst_lines,
        "cfs": {"standard": {"x": float(std_2d[0]), "y": float(std_2d[1]),
                             "distance": round(float(np.linalg.norm(cf_std - x0)), 3)},
                "ellice":   {"x": float(rob_2d[0]), "y": float(rob_2d[1]),
                             "distance": round(float(np.linalg.norm(cf_rob - x0)), 3)},
                "sparse":   {"x": float(sparse_2d[0]), "y": float(sparse_2d[1]),
                             "distance": round(float(np.linalg.norm(cf_sparse - x0)), 3)}},
        "metrics": metrics,
        "_cf_rob_full": cf_rob,
        "_cf_std_full": cf_std,
        "_cf_sparse_full": cf_sparse,
        "_theta_w": theta_w,
    }


def _feature_deltas(setup, x0, panels, rule=None):
    """Per-feature changes for each model: the safe (robust) change under the
    model's name, and the quick (standard) change under "<model>_quick"."""
    data = setup["data"]
    sc = data.scaler
    meta = {f["name"]: f for f in data.feature_meta()}
    out = []
    for j, name in enumerate(data.feature_names):
        fm = meta[name]
        x0r = float(sc.mean_[j] + sc.scale_[j] * x0[j])
        row = {
            "name": name,
            "label": fm["label"], "unit": fm["unit"], "desc": fm["desc"],
            "integer": fm["integer"],
            "group": fm.get("group", ""),
            "group_label": fm.get("group_label", ""),
            "value_label": fm.get("value_label", ""),
            "immutable": (rule[name] == "fixed") if rule else name in setup["immutable"],
            "rule": rule[name] if rule else ("fixed" if name in setup["immutable"] else "free"),
            "missing": False,
            "x0_real": x0r,
            "pct_x0": _percentile(data.X[:, j], x0[j]),
        }
        for key, panel in panels.items():
            for suffix, cf in (("", panel["_cf_rob_full"]), ("_quick", panel["_cf_std_full"]),
                               ("_sparse", panel["_cf_sparse_full"])):
                d_std = float(cf[j] - x0[j])
                row[key + suffix] = {
                    "delta_std": round(d_std, 4),
                    "delta_real": round(d_std * float(sc.scale_[j]), 4),
                    "cf_real": round(float(sc.mean_[j] + sc.scale_[j] * cf[j]), 4),
                    "pct_cf": round(_percentile(data.X[:, j], float(cf[j])), 1),
                }
        out.append(row)
    return out


def people(dataset_key, customs, eps=0.03, lens=None):
    """Predictions and map positions for several entered people, without a map.

    Each chance range is computed exactly as the verdict card's.
    """
    setup = _setup(dataset_key, float(np.clip(eps, 0.005, 0.2)), lens)
    data, lens = setup["data"], setup["lens"]
    lin, ell, mlp = setup["lin"], setup["lin_ell"], setup["mlp"]
    names = [str(n) for n in data.feature_names]
    out = []
    for custom in customs:
        x0, provided = _custom_x0(setup, custom)
        X = x0[None, :]
        z = lens.embed(x0)[0]
        res = {"x": float(z[0]), "y": float(z[1])}
        for key, logit, rob in (("linear", lin.logit(X), ell.robust_logit(X, TARGET_CLASS)),
                                ("mlp", mlp.logit(X), mlp.robust_logit(X, TARGET_CLASS))):
            lg = float(logit[0])
            pen = max(-(lg + float(rob[0])), 0.0)
            res[key] = {"p": round(float(_sigmoid(lg)), 4), "lo": round(float(_sigmoid(lg - pen)), 4),
                        "hi": round(float(_sigmoid(lg + pen)), 4)}
        real = data.to_real(x0)
        res["values"] = {n: round(float(v), 4) for n, v in zip(names, real)}
        res["pct"] = {n: round(float(_percentile(data.X[:, j], x0[j])), 1) for j, n in enumerate(names)}
        res["provided"] = [n for n, ok in zip(names, provided) if ok]
        out.append(res)
    return {"class_names": list(data.class_names), "features": setup["features"],
            "importance": setup["scatter_info"]["importance"], "people": out}


IG_STEPS = 64


def _drivers(setup, x0):
    """How much each value pushes this person's score, compared with an average person
    (standardized values are 0 there), for each model, with the range across the good
    models.

    Simple model: value j adds w_j * x_j. Flexible model: integrated gradients along the
    straight line from the average person, which add up to the same score difference.
    Both are linear in the (last-layer) weights theta, so over the Rashomon ellipsoid
    theta = theta_hat + Q^-1/2 u, |u| <= 1, each push g . theta ranges exactly over
    g . theta_hat +- |Q^-1/2 g|. A range that crosses 0 means the good models disagree
    on which way that value pushes.
    """
    lin, ell, mlp = setup["lin"], setup["lin_ell"], setup["mlp"]
    d = len(x0)
    G_lin = np.zeros((d, d + 1))
    G_lin[np.arange(d), np.arange(d)] = x0                       # push_j = theta_j * x_j
    t = (np.arange(IG_STEPS) + 0.5) / IG_STEPS
    slope = 1.0 - np.tanh(t[:, None] * (x0 @ mlp.W1) + mlp.b1) ** 2
    G_mlp = np.zeros((d, len(mlp.theta)))
    G_mlp[:, :-1] = x0[:, None] * mlp.W1 * slope.mean(axis=0)[None, :]
    names = [str(n) for n in setup["data"].feature_names]
    labels = {f["name"]: f["label"] for f in setup["features"]}
    out = {}
    for key, G, theta, e in (("linear", G_lin, lin.theta, ell), ("mlp", G_mlp, mlp.theta, mlp.ell)):
        push = G @ theta
        half = np.linalg.norm(G @ e.Q_inv_sqrt, axis=1)
        rows = [{"name": n, "label": labels.get(n, n), "push": round(float(c), 4),
                 "lo": round(float(c - h), 4), "hi": round(float(c + h), 4)}
                for n, c, h in zip(names, push, half)]
        rows.sort(key=lambda r: -abs(r["push"]))
        base = float(lin.logit(np.zeros((1, d)))[0] if key == "linear" else mlp.logit(np.zeros((1, d)))[0])
        out[key] = {"base": round(base, 4), "rows": rows}
    return out


REPORT_PEOPLE = 40
_REPORTS = {}


def _spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def lens_report(dataset_key, eps=0.03):
    """How each map (PCA, ECLIPSE) shows the simple model, for the comparison page.

    score_read / disagree_read: rank correlation between each person's score (or how
    much the good models disagree about them) and that of the person the map shows at
    their spot. shows_model: share of the model's direction the map keeps. For a fixed
    sample of people the model flags, with the topic's default rules: how much of each
    suggested change lands on the map (median), and how often the map draws the change
    on the correct side of its line (quick past the model's line, safe past the
    strictest model's line).
    """
    eps = float(np.clip(eps, 0.005, 0.2))
    key = (dataset_key, round(eps, 6))
    if key in _REPORTS:
        return _REPORTS[key]
    m = _models(dataset_key, eps)
    data, lin, ell = m["data"], m["lin"], m["lin_ell"]
    X = np.asarray(data.X, float)
    bad = np.where(lin.logit(X) > 0)[0]
    sample = np.random.default_rng(0).choice(bad, min(REPORT_PEOPLE, len(bad)), replace=False)
    changes = []
    for i in sample:
        x0 = X[i]
        fixed, limits, _ = _rules({**_actions(dataset_key, m), "data": data,
                                   "limits": (X.min(axis=0), X.max(axis=0))}, x0)
        q = ell.standard_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=fixed, limits=limits)
        r = ell.robust_cf(x0, TARGET_CLASS, margin=MARGIN, fixed=fixed, limits=limits)
        changes.append((x0, q, r, ell.worst_model(r, TARGET_CLASS),
                        -float(lin.logit(q)[0]) >= MARGIN - 1e-3,
                        float(ell.robust_logit(r[None, :], TARGET_CLASS)[0]) >= MARGIN - 1e-3))

    cov = np.cov(X.T)
    out = {}
    for kind in LENSES:
        lens = _lens(dataset_key, eps, kind)
        A, mean = lens.comp, lens.mean
        spot = lambda Z: (np.atleast_2d(Z) - mean) @ A.T @ A + mean
        share = lambda v: float(np.linalg.norm(A @ v) / max(np.linalg.norm(v), 1e-12))
        shown, right = [], []
        for x0, q, r, th_w, q_ok, r_ok in changes:
            if q_ok:
                shown.append(share(q - x0))
                right.append(float(lin.logit(spot(q))[0]) < 0)
            if r_ok:
                shown.append(share(r - x0))
                right.append(float(np.append(spot(r)[0], 1.0) @ th_w) < 0)
        Xs = spot(X)
        out[kind] = {
            "label": lens.label, "extra": lens.extra,
            "trust": lens.quality["trust"],
            "kept": round(float(np.trace(A @ cov @ A.T) / np.trace(cov)), 3),
            "shows_model": round(share(lin.w), 3),
            "score_read": round(_spearman(lin.logit(X), lin.logit(Xs)), 3),
            "disagree_read": round(_spearman(disagreement(ell, X), disagreement(ell, Xs)), 3),
            "change_shown": round(float(np.median(shown)), 3) if shown else None,
            "map_right": round(float(np.mean(right)), 3) if right else None,
            "n_changes": len(right),
        }
    _REPORTS[key] = {"dataset": data.name, "key": dataset_key, "eps": eps,
                     "people": int(len(sample)), "lenses": out}
    return _REPORTS[key]


def get_scene(dataset_key, eps=0.03, query_id=None, custom=None, constraints=None,
              view="everyone", lens=None):
    """Return the JSON scene for a dataset row or entered values.

    ``view`` "around" rebuilds each model's map around the person (see _around).
    """
    eps = float(np.clip(eps, 0.005, 0.2))
    setup = _setup(dataset_key, eps, lens)
    data, emb, lens = setup["data"], setup["emb"], setup["lens"]

    if custom is not None:
        x0, provided = _custom_x0(setup, custom)
        x0_2d = lens.embed(x0)[0]
        pred = int(_sigmoid(float(setup["lin"].logit(x0)[0])) > 0.5)
        real = data.to_real(x0)
        query = {"id": None, "custom": True,
                 "x": float(x0_2d[0]), "y": float(x0_2d[1]), "outcome": pred,
                 # entered values the models never saw anything like
                 "outside": [f["label"] for f, v, ok in zip(setup["features"], real, provided)
                             if ok and not f["min"] - 1e-6 <= v <= f["max"] + 1e-6]}
    else:
        if query_id is None or not (0 <= int(query_id) < data.n):
            query_id = _pick_query(setup)
        query_id = int(query_id)
        x0 = data.X[query_id].astype(float)
        x0_2d = emb[query_id]
        query = {"id": query_id, "custom": False,
                 "x": float(x0_2d[0]), "y": float(x0_2d[1]),
                 "outcome": int(data.y[query_id])}

    fixed, limits, rule = _rules(setup, x0, constraints)
    panels = {"linear": _panel(setup, "linear", x0, fixed, limits),
              "mlp": _panel(setup, "mlp", x0, fixed, limits)}

    if view == "around":
        for which, p in panels.items():
            _around(setup, which, x0, p)
        query["x"], query["y"] = 0.0, 0.0

    deltas = _feature_deltas(setup, x0, panels, rule)
    for j, row in enumerate(deltas):
        row["missing"] = (bool(not provided[j]) if custom is not None
                          else bool(data.missing_mask[query["id"], j]))
    for p in panels.values():
        del p["_cf_rob_full"], p["_cf_std_full"], p["_cf_sparse_full"], p["_theta_w"]
    drivers = _drivers(setup, x0)

    idx, si = setup["scatter_idx"], setup["scatter_info"]
    pts_payload = [{"id": int(i), "x": float(emb[i, 0]), "y": float(emb[i, 1]),
                    "outcome": int(data.y[i]),
                    "p": round(float(si["p"][k]), 3),
                    "lo": round(float(si["lo"][k]), 3),
                    "hi": round(float(si["hi"][k]), 3),
                    "v": [round(float(v), 3) for v in si["vals"][k]]}
                   for k, i in enumerate(idx)]
    key_features = [{"name": str(setup["features"][j]["name"]),
                     "label": str(setup["features"][j]["label"]),
                     "unit": setup["features"][j].get("unit", ""),
                     "integer": bool(setup["features"][j].get("integer"))}
                    for j in si["key_j"]]

    lo, hi = setup["bounds"]
    return {
        "dataset": data.name,
        "class_names": list(data.class_names),
        "eps": eps,
        "view": view,
        # To place a what-if person on an "around" slice: (real - mean) / scale.
        "std": {"mean": [float(v) for v in data.scaler.mean_],
                "scale": [float(v) for v in data.scaler.scale_]},
        "lens": {"key": lens.key, "label": lens.label,
                 "is_linear": bool(lens.is_linear),
                 "extra": lens.extra, "blurb": lens.blurb,
                 "quality": lens.quality},
        "bounds": {"x": [float(lo[0]), float(hi[0])],
                   "y": [float(lo[1]), float(hi[1])]},
        "points": pts_payload,
        "key_features": key_features,
        "importance": si["importance"],
        "query": query,
        "panels": panels,
        "deltas": deltas,
        "drivers": drivers,
        "features": setup["features"],
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="smoke-test scenes offline")
    ap.add_argument("--datasets", nargs="*",
                    default=[d["key"] for d in DATASETS])
    args = ap.parse_args()

    for dkey in args.datasets:
        s = get_scene(dkey, eps=0.03)
        q = s["lens"]["quality"]
        print(f"{s['dataset']:14s} {s['lens']['extra']}")
        print(f"    lens quality: recon={q['recon']:.3f} "
              f"trust={q['trust']:.3f} rt={q['rt']:.3f}")
        for name, p in s["panels"].items():
            m = p["metrics"]
            print(f"    {name:6s} acc={p['acc']:.3f} auc={p['auc']:.3f}  "
                  f"cost std={m['cost_std']:.3f} rob={m['cost_rob']:.3f}  "
                  f"margin(cf)={m['robust_margin_cf']:+.3f}  "
                  f"worst_closer={m['worst_closer']}")
        feats = s["features"]
        custom = {feats[0]["name"]: feats[0]["max"]}
        sc = get_scene(dkey, eps=0.03, custom=custom)
        mc = sc["panels"]["linear"]["metrics"]
        print(f"    custom person: P(bad)={mc['p_bad_erm_x0']:.2f} "
              f"cost rob={mc['cost_rob']:.3f} "
              f"imputed={sum(r['missing'] for r in sc['deltas'])}/{len(feats)}")
