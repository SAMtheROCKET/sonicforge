# Optional CI

`github-pages-workflow.yml` runs the full verification pipeline on every push
and then deploys to GitHub Pages:

1. no absolute asset paths (they break `/repo-name/` subpath hosting)
2. every file referenced by the HTML exists
3. every module import resolves and every DOM id exists
4. the service-worker precache manifest is current
5. every style rule in STYLE_GUIDE.md

The site does **not** need this. SonicForge is fully static, so Pages can
serve the repository root directly — which is how it is deployed today.

## Enabling it

Creating a file under `.github/workflows/` requires a token with the
`workflow` scope, which is why it lives here instead.

```bash
gh auth refresh -s workflow      # one-time, opens a browser
mkdir -p .github/workflows
cp ci/github-pages-workflow.yml .github/workflows/pages.yml
git add .github && git commit -m "Enable CI" && git push
```

Then set **Settings → Pages → Source** to **GitHub Actions**.

You can always run the same checks locally:

```bash
python tools/check_wiring.py
python tools/build_precache.py --check
python tools/lint_style.py --summary
```
