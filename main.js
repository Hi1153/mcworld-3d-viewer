
import * as THREE from 'https://esm.sh/three@0.180.0';
import { OrbitControls } from 'https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js';
import { readMcworld } from 'https://esm.sh/mcbe-leveldb-reader@5.0.1';

const $ = (id) => document.getElementById(id);
const fileInput = $('worldFile');
const dropzone = $('dropzone');
const loadButton = $('loadButton');
const viewport = $('viewport');
const statusBox = $('status');
const loading = $('loading');

let selectedFile = null;
let scene, camera, renderer, controls, worldGroup, resizeObserver;
let initialCamera = null;

const MAX_SUBCHUNKS = 3500;
const MAX_BLOCKS = 450000;
const MAX_RENDERED = 130000;

function setStatus(message, type = '') {
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
}

function setLoading(show, title = '読み込み中…', message = 'ワールドのデータを確認しています。') {
  if (!loading) return;
  loading.classList.toggle('hidden', !show);
  if ($('loadingTitle')) $('loadingTitle').textContent = title;
  if ($('loadingText')) $('loadingText').textContent = message;
}

function chooseFile(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.mcworld')) {
    setStatus('拡張子が .mcworld のファイルを選択してください。', 'error');
    return;
  }

  selectedFile = file;

  const fileNameBox = $('fileName') || $('fileStatus');

  if (fileNameBox) {
    fileNameBox.textContent = $('fileName')
      ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
      : `選択済み：${file.name}`;
  }

  if (loadButton) loadButton.disabled = false;

  setStatus('ファイルを選択しました。3D表示を開始できます。');
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    chooseFile(fileInput.files?.[0]);
  });
}

if (dropzone) {
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput?.click();
    }
  });

  for (const name of ['dragenter', 'dragover']) {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }

  for (const name of ['dragleave', 'drop']) {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
    });
  }

  dropzone.addEventListener('drop', (event) => {
    chooseFile(event.dataTransfer?.files?.[0]);
  });
}

if (loadButton) {
  loadButton.addEventListener('click', loadWorld);
}

$('resetView')?.addEventListener('click', resetCamera);

$('fullscreen')?.addEventListener('click', () => {
  document.body.classList.toggle('viewer-fullscreen');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.body.classList.remove('viewer-fullscreen');
  }
});

function initScene() {
  if (renderer) return;

  if (!viewport) {
    throw new Error('3D表示領域 viewport がHTMLにありません。');
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#f7faf9');

  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 10000);
  camera.position.set(90, 75, 90);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.minDistance = 4;
  controls.maxDistance = 2500;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x83928b, 2.15));

  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(120, 180, 100);
  scene.add(sun);

  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resizeRenderer());
    resizeObserver.observe(viewport);
  } else {
    window.addEventListener('resize', resizeRenderer);
  }

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

function resizeRenderer() {
  if (!renderer || !camera || !viewport) return;

  const w = Math.max(1, viewport.clientWidth);
  const h = Math.max(1, viewport.clientHeight);

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function resetCamera() {
  if (!controls || !initialCamera) return;

  camera.position.copy(initialCamera.position);
  controls.target.copy(initialCamera.target);
  controls.update();
}

function keyByte(key, index) {
  return key.charCodeAt(index) & 255;
}

function int32LEFromKey(key, offset) {
  const b = new Uint8Array([
    keyByte(key, offset),
    keyByte(key, offset + 1),
    keyByte(key, offset + 2),
    keyByte(key, offset + 3)
  ]);

  return new DataView(b.buffer).getInt32(0, true);
}

function signedByte(n) {
  return n > 127 ? n - 256 : n;
}

function isAir(name) {
  return !name ||
    name === 'minecraft:air' ||
    name === 'minecraft:cave_air' ||
    name === 'minecraft:void_air';
}

// Bedrock persistent block palettes use little-endian NBT compounds.
function parseNbtCompound(bytes, state) {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const readU8 = () => {
    if (state.p >= bytes.length) {
      throw new Error('NBTデータが途中で終わっています');
    }
    return bytes[state.p++];
  };

  const readI16 = () => {
    const v = view.getInt16(state.p, true);
    state.p += 2;
    return v;
  };

  const readU16 = () => {
    const v = view.getUint16(state.p, true);
    state.p += 2;
    return v;
  };

  const readI32 = () => {
    const v = view.getInt32(state.p, true);
    state.p += 4;
    return v;
  };

  const readI64 = () => {
    const v = view.getBigInt64(state.p, true);
    state.p += 8;
    return v;
  };

  const readF32 = () => {
    const v = view.getFloat32(state.p, true);
    state.p += 4;
    return v;
  };

  const readF64 = () => {
    const v = view.getFloat64(state.p, true);
    state.p += 8;
    return v;
  };

  const readString = () => {
    const length = readU16();

    if (state.p + length > bytes.length) {
      throw new Error('NBT文字列の長さが不正です');
    }

    const s = new TextDecoder().decode(
      bytes.subarray(state.p, state.p + length)
    );

    state.p += length;
    return s;
  };

  const payload = (type, depth = 0) => {
    if (depth > 40) {
      throw new Error('NBTの階層が深すぎます');
    }

    switch (type) {
      case 1:
        return (readU8() << 24) >> 24;

      case 2:
        return readI16();

      case 3:
        return readI32();

      case 4:
        return readI64().toString();

      case 5:
        return readF32();

      case 6:
        return readF64();

      case 7: {
        const n = readI32();

        if (n < 0 || n > 10000000 || state.p + n > bytes.length) {
          throw new Error('NBT byte array length is invalid');
        }

        const a = bytes.slice(state.p, state.p + n);
        state.p += n;
        return a;
      }

      case 8:
        return readString();

      case 9: {
        const childType = readU8();
        const n = readI32();

        if (n < 0 || n > 1000000) {
          throw new Error('NBT list length is invalid');
        }

        const a = [];

        for (let i = 0; i < n; i++) {
          a.push(payload(childType, depth + 1));
        }

        return a;
      }

      case 10: {
        const o = {};

        while (state.p < bytes.length) {
          const t = readU8();

          if (t === 0) break;

          const name = readString();
          o[name] = payload(t, depth + 1);
        }

        return o;
      }

      case 11: {
        const n = readI32();

        if (n < 0 || n > 1000000) {
          throw new Error('NBT int array length is invalid');
        }

        const a = [];

        for (let i = 0; i < n; i++) {
          a.push(readI32());
        }

        return a;
      }

      case 12: {
        const n = readI32();

        if (n < 0 || n > 1000000) {
          throw new Error('NBT long array length is invalid');
        }

        const a = [];

        for (let i = 0; i < n; i++) {
          a.push(readI64().toString());
        }

        return a;
      }

      default:
        throw new Error(`未対応のNBTタグ: ${type}`);
    }
  };

  const rootType = readU8();

  if (rootType !== 10) {
    throw new Error('ブロックパレットがNBT Compoundではありません');
  }

  readString();

  return payload(10);
}

function readPalette(bytes, cursor) {
  const state = { p: cursor };
  const palette = parseNbtCompound(bytes, state);

  return {
    palette,
    cursor: state.p
  };
}

function parseStorage(bytes, cursor) {
  if (cursor >= bytes.length) {
    throw new Error('サブチャンクのストレージデータがありません');
  }

  const header = bytes[cursor++];
  const bits = header >> 1;

  let indices = null;
  let palette = [];

  if (bits === 0) {
    const result = readPalette(bytes, cursor);
    palette = [result.palette];
    cursor = result.cursor;
  } else {
    const perWord = Math.floor(32 / bits);
    const wordCount = Math.ceil(4096 / perWord);

    if (cursor + wordCount * 4 + 4 > bytes.length) {
      throw new Error('ブロックインデックスのデータが不足しています');
    }

    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    );

    const words = new Uint32Array(wordCount);

    for (let i = 0; i < wordCount; i++) {
      words[i] = view.getUint32(cursor + i * 4, true);
    }

    cursor += wordCount * 4;
    indices = new Uint16Array(4096);

    const mask = (2 ** bits) - 1;

    for (let i = 0; i < 4096; i++) {
      const word = words[Math.floor(i / perWord)];
      indices[i] = (word >>> ((i % perWord) * bits)) & mask;
    }

    if (cursor + 4 > bytes.length) {
      throw new Error('パレット数のデータが不足しています');
    }

    const count = view.getInt32(cursor, true);
    cursor += 4;

    if (count < 1 || count > 65536) {
      throw new Error(`パレット数が不正です: ${count}`);
    }

    for (let i = 0; i < count; i++) {
      const result = readPalette(bytes, cursor);
      palette.push(result.palette);
      cursor = result.cursor;
    }
  }

  return { indices, palette, cursor };
}

function parseSubchunk(bytes, keyY) {
  if (!bytes || bytes.length < 2) return null;

  const version = bytes[0];

  if (version !== 8 && version !== 9) {
    return { unsupported: version };
  }

  let cursor = 1;
  const storageCount = bytes[cursor++];
  let subY = keyY;

  if (version === 9) {
    if (cursor >= bytes.length) return null;
    subY = signedByte(bytes[cursor++]);
  }

  if (storageCount < 1 || storageCount > 8) return null;

  const layers = [];

  for (let layer = 0; layer < storageCount; layer++) {
    const storage = parseStorage(bytes, cursor);
    layers.push(storage);
    cursor = storage.cursor;
  }

  return { subY, layers };
}

function paletteName(paletteEntry) {
  if (typeof paletteEntry === 'string') return paletteEntry;

  return paletteEntry?.name ||
    paletteEntry?.Name ||
    'unknown';
}

function blockColor(name) {
  const n = (name || '').replace('minecraft:', '');

  if (n.includes('water') || n.includes('bubble_column')) return 0x5a9fe8;
  if (n.includes('lava') || n.includes('magma')) return 0xe77935;

  if (
    n.includes('grass') ||
    n.includes('leaves') ||
    n.includes('moss') ||
    n.includes('fern') ||
    n.includes('vine')
  ) {
    return n.includes('leaves') ? 0x4e9a53 : 0x70ad59;
  }

  if (n.includes('dirt') || n.includes('mud') || n.includes('farmland') || n.includes('podzol')) return 0x8b6548;
  if (n.includes('sand') || n.includes('sandstone') || n.includes('end_stone')) return 0xd9c58b;
  if (n.includes('snow') || n.includes('quartz') || n.includes('calcite') || n.includes('diorite')) return 0xe5e9e8;
  if (n.includes('stone') || n.includes('deepslate') || n.includes('andesite') || n.includes('granite') || n.includes('tuff')) return 0x858b90;
  if (n.includes('log') || n.includes('wood') || n.includes('planks') || n.includes('stem') || n.includes('hyphae')) return 0x9b7049;
  if (n.includes('brick') || n.includes('terracotta') || n.includes('copper')) return 0xb96e54;
  if (n.includes('glass')) return 0x9bd8d9;
  if (n.includes('wool') || n.includes('concrete') || n.includes('shulker')) return 0xb3a5d8;
  if (n.includes('iron') || n.includes('chain') || n.includes('metal')) return 0xb8c1c7;
  if (n.includes('gold')) return 0xe3bf4f;
  if (n.includes('diamond') || n.includes('prismarine')) return 0x59c5ad;
  if (n.includes('coal') || n.includes('obsidian') || n.includes('blackstone')) return 0x45434f;
  if (n.includes('flower') || n.includes('tulip') || n.includes('rose') || n.includes('torchflower')) return 0xd88bb5;

  return 0x9da8a0;
}

function isTransparentLike(name) {
  return isAir(name) ||
    /water|lava|glass|leaves|flower|tallgrass|short_grass|fern|vine|torch|rail|ladder|seagrass|kelp|fire|snow_layer|carpet|button|pressure_plate/.test(name || '');
}

function blockKey(x, y, z) {
  return `${x},${y},${z}`;
}

async function loadWorld() {
  if (!selectedFile) {
    setStatus('先に .mcworld ファイルを選択してください。', 'error');
    return;
  }

  if (!loadButton) {
    setStatus('3D描画ボタンがHTMLにありません。', 'error');
    return;
  }

  loadButton.disabled = true;

  $('emptyState')?.classList.add('hidden');

  setLoading(
    true,
    'ワールドを解析中…',
    'LevelDBとチャンクデータを読み込んでいます。大きなワールドでは時間がかかります。'
  );

  setStatus('LevelDBを読み込んでいます…');

  if ($('chunkCount')) $('chunkCount').textContent = '…';
  if ($('blockCount')) $('blockCount').textContent = '…';
  if ($('renderCount')) $('renderCount').textContent = '…';

  try {
    initScene();

    const entries = await readMcworld(selectedFile);

    if (!(entries instanceof Map)) {
      throw new Error('LevelDBの読み込み結果が想定と異なります');
    }

    setLoading(
      true,
      'チャンクを解析中…',
      `${entries.size.toLocaleString()} 個のLevelDBキーを確認しました。`
    );

    setStatus(
      `${entries.size.toLocaleString()} 個のLevelDBキーを取得。サブチャンクを探しています…`
    );

    const subs = [];

    for (const [key, entry] of entries) {
      const length = key.length;

      if (
        (length !== 10 && length !== 14) ||
        keyByte(key, length - 2) !== 0x2f
      ) {
        continue;
      }

      const x = int32LEFromKey(key, 0);
      const z = int32LEFromKey(key, 4);
      const dimension = length === 14 ? int32LEFromKey(key, 8) : 0;
      const y = signedByte(keyByte(key, length - 1));

      if (dimension !== 0) continue;

      if (entry?.value instanceof Uint8Array) {
        subs.push({ key, x, z, y, bytes: entry.value });
      }

      if (subs.length >= MAX_SUBCHUNKS) break;
    }

    if (!subs.length) {
      throw new Error(
        'サブチャンクが見つかりません。対応するBedrock .mcworldか確認してください。'
      );
    }

    const blocks = new Map();
    let parsedCount = 0;
    let unsupported = 0;

    const yieldedEvery = 35;

    for (let si = 0; si < subs.length; si++) {
      const sub = subs[si];
      let parsed;

      try {
        parsed = parseSubchunk(sub.bytes, sub.y);
      } catch (error) {
        console.warn('Subchunk parse failed:', sub.key, error);
        continue;
      }

      if (!parsed || parsed.unsupported) {
        if (parsed?.unsupported) unsupported++;
        continue;
      }

      parsedCount++;

      const solid = parsed.layers[0];
      const fluid = parsed.layers[1];

      for (let i = 0; i < 4096; i++) {
        const ix = Math.floor(i / 256);
        const iz = Math.floor(i / 16) % 16;
        const iy = i % 16;

        const nameAt = (layer) => {
          if (!layer) return '';

          const paletteIndex = layer.indices ? layer.indices[i] : 0;

          return paletteName(layer.palette[paletteIndex]);
        };

        let name = nameAt(solid);

        if (isAir(name)) {
          const fluidName = nameAt(fluid);
          if (!isAir(fluidName)) name = fluidName;
        }

        if (isAir(name)) continue;

        const wx = sub.x * 16 + ix;
        const wy = parsed.subY * 16 + iy;
        const wz = sub.z * 16 + iz;

        blocks.set(blockKey(wx, wy, wz), {
          x: wx,
          y: wy,
          z: wz,
          name
        });

        if (blocks.size >= MAX_BLOCKS) break;
      }

      if (blocks.size >= MAX_BLOCKS) break;

      if (si % yieldedEvery === 0) {
        if ($('loadingText')) {
          $('loadingText').textContent =
            `サブチャンク ${si + 1} / ${subs.length} · ブロック ${blocks.size.toLocaleString()}`;
        }

        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (!blocks.size) {
      throw new Error(
        'ブロックを復元できませんでした。旧形式のワールドか、未対応のチャンク形式の可能性があります。'
      );
    }

    setLoading(
      true,
      '3Dモデルを作成中…',
      `${blocks.size.toLocaleString()} 個のブロックを確認しました。表面を抽出しています。`
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    renderBlocks(blocks);

    if ($('chunkCount')) $('chunkCount').textContent = parsedCount.toLocaleString();

    if ($('blockCount')) {
      $('blockCount').textContent =
        blocks.size.toLocaleString() +
        (blocks.size >= MAX_BLOCKS ? '+' : '');
    }

    if ($('renderCount')) {
      $('renderCount').textContent =
        Math.min(blocks.size, MAX_RENDERED).toLocaleString();
    }

    if ($('viewerHint')) {
      $('viewerHint').textContent = `${selectedFile.name} · Overworld`;
    }

    if ($('dimensionLabel')) {
      $('dimensionLabel').textContent = 'Overworld';
    }

    const warnings = [];

    if (subs.length >= MAX_SUBCHUNKS) {
      warnings.push('処理したサブチャンク数に上限を適用しました');
    }

    if (blocks.size >= MAX_BLOCKS) {
      warnings.push('ブロック数に上限を適用しました');
    }

    if (unsupported) {
      warnings.push(`${unsupported} 個の旧形式サブチャンクは未対応です`);
    }

    setStatus(
      `読み込み完了。${warnings.length ? warnings.join('。') + '。' : 'マウスや指で回転・ズームできます。'}`,
      'success'
    );

    setLoading(false);
  } catch (error) {
    console.error(error);
    setLoading(false);

    $('emptyState')?.classList.remove('hidden');

    setStatus(
      `読み込みエラー: ${error?.message || error}`,
      'error'
    );
  } finally {
    loadButton.disabled = !selectedFile;
  }
}

function renderBlocks(blocks) {
  while (worldGroup.children.length) {
    const child = worldGroup.children[0];
    worldGroup.remove(child);

    child.geometry?.dispose();

    if (Array.isArray(child.material)) {
      child.material.forEach(material => material.dispose());
    } else {
      child.material?.dispose();
    }
  }

  const all = Array.from(blocks.values());
  const exposed = [];

  const neighbors = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ];

  for (const block of all) {
    let visible = false;

    for (const [dx, dy, dz] of neighbors) {
      const neighbor = blocks.get(
        blockKey(block.x + dx, block.y + dy, block.z + dz)
      );

      if (!neighbor || isTransparentLike(neighbor.name)) {
        visible = true;
        break;
      }
    }

    if (visible) exposed.push(block);

    if (exposed.length >= MAX_RENDERED) break;
  }

  if (!exposed.length) {
    throw new Error('描画できるブロックがありません。');
  }

  const geometry = new THREE.BoxGeometry(0.985, 0.985, 0.985);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0
  });

  const mesh = new THREE.InstancedMesh(
    geometry,
    material,
    exposed.length
  );

  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  exposed.forEach((block, i) => {
    dummy.position.set(block.x, block.y, block.z);
    dummy.updateMatrix();

    mesh.setMatrixAt(i, dummy.matrix);

    color.setHex(blockColor(block.name));
    mesh.setColorAt(i, color);

    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    minZ = Math.min(minZ, block.z);

    maxX = Math.max(maxX, block.x);
    maxY = Math.max(maxY, block.y);
    maxZ = Math.max(maxZ, block.z);
  });

  mesh.instanceMatrix.needsUpdate = true;

  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }

  worldGroup.add(mesh);

  const center = new THREE.Vector3(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );

  worldGroup.position.set(-center.x, -center.y, -center.z);

  const size = Math.max(
    maxX - minX + 1,
    maxY - minY + 1,
    maxZ - minZ + 1,
    20
  );

  const distance = size * 1.2 + 25;

  camera.position.set(
    distance,
    distance * 0.78,
    distance
  );

  camera.near = 0.1;
  camera.far = Math.max(5000, distance * 10);
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.minDistance = Math.max(3, size * 0.06);
  controls.maxDistance = Math.max(1000, size * 6);
  controls.update();

  initialCamera = {
    position: camera.position.clone(),
    target: controls.target.clone()
  };

  $('emptyState')?.classList.add('hidden');
}
