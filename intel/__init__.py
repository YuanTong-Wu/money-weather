"""情报投喂 (DESIGN.md §11): turn pasted news / a URL into intel events on their own map layer.

Measured weather is never touched here. Everything this package writes lives in one file,
`store.INTEL_PATH`, which the frontend reads as a separate, deletable layer.
"""
