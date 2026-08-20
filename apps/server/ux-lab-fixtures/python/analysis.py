"""Cohort analysis — UX Lab fixture.

This file exists so the compute editor strip has a real `.py` buffer to sit
under. It is deliberately written in `# %%` cells, because the caret-based
"Run cell" action is one of the decisions under review and it cannot be judged
against a file with no cell boundaries.
"""

# %%
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

# %%
cohort = pd.read_parquet("data/cohort.parquet")
cohort = cohort[cohort.arm.isin(["treatment", "control"])]
print(f"{len(cohort)} subjects, {cohort.arm.nunique()} arms")

# %%
summary = cohort.groupby("arm").week12.agg(["mean", "std", "count"])
print(summary)

# %%
fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=100)
for arm, rows in cohort.groupby("arm"):
    ax.hist(rows.week12, bins=24, alpha=0.6, label=arm)
ax.set_xlabel("Week 12 score")
ax.set_ylabel("Subjects")
ax.legend()
fig.tight_layout()

# %%
delta = summary.loc["treatment", "mean"] - summary.loc["control", "mean"]
pooled = np.sqrt((summary.loc["treatment", "std"] ** 2 + summary.loc["control", "std"] ** 2) / 2)
print(f"delta={delta:.3f}  cohen_d={delta / pooled:.3f}")

# %%
# Fails until the merge key is renamed upstream — the traceback scenario.
enriched = cohort.merge(pd.read_csv("data/labs.csv"), on="subject_id")

# %%
enriched.to_csv("results/enriched.csv", index=False)
