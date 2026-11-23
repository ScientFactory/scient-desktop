# Notebook serialization fixtures

`attachments.ipynb` and `attachments-folded.ipynb` are synthetic. Both were
validated and written by Python nbformat. The second differs by one
`metadata.collapsed` flag and records nbformat's expected cell serialization.

`transfusion-excerpt.ipynb` contains the first two cells of the Inria
scikit-learn MOOC's blood transfusion notebook, reserialized as nbformat 4.4
with cell IDs removed. The original is by the scikit-learn MOOC contributors.
[Original notebook](https://github.com/INRIA/scikit-learn-mooc/blob/d114e31fdd6ed7d456f5f776e4c406d928e2679b/notebooks/datasets_blood_transfusion.ipynb)
and [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/).
