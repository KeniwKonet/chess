# Chess Realms: ready-to-serve site

This branch is built automatically from `main` (see `.github/workflows/deploy-branch.yml` on `main`).
It contains only static files, with nothing to install, so any static host can serve it directly:
point the host at the **`deploy`** branch, with no build command and the repository root as the output folder.

Do not edit this branch by hand: it is replaced on every push to `main`.
