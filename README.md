# Minecraft World Viewer 3D

A static GitHub Pages prototype for visualizing Minecraft Bedrock `.mcworld` files in the browser.

## Publish on GitHub Pages

1. Upload `index.html`, `style.css`, `main.js`, and `README.md` to the root of `Hi1153/mcworld-3d-viewer`.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Choose branch `main` and folder `/(root)`, then Save.
5. Open `https://hi1153.github.io/mcworld-3d-viewer/` after deployment completes.

## Notes

- Runs in the browser; selected world data is not uploaded to a server by this app.
- Uses `mcbe-leveldb-reader` to read LevelDB keys and Three.js to render blocks.
- Initial prototype supports Bedrock persistent subchunk formats 8 and 9 and renders the Overworld. Legacy formats and some special cases are not supported yet.
- For performance, processing is limited to 3,500 subchunks, 450,000 decoded non-air blocks, and 130,000 rendered surface blocks. Very large worlds may be partial.
- Block colors are approximations based on block names, not the official Minecraft textures.
- External ES modules are loaded from esm.sh, so the browser needs internet access.
