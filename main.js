import * as THREE from 'https://esm.sh/three@0.180.0';
import { OrbitControls } from 'https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js';

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

function setStatus(message, type = '') {
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
}

function setLoading(show, title = '読み込み中…', message = 'ワールドのデータを確認しています。') {
  if (!loading) return;
  loading.classList.toggle('hidden', !show);
  if ($('loadingTitle'))$('loadingTitle').textContent = title;
  if ($('loadingText'))$('loadingText').textContent = message;
}

function chooseFile(file) {
  if (!file) return;

  const extension = file.name.split('.').pop().toLowerCase();

  if (extension !== 'mcworld' && extension !== 'zip') {
    selectedFile = null;
    if (loadButton) loadButton.disabled = true;
    setStatus('未対応の拡張子です。.mcworld または .zip ファイルを選択してください。', 'error');
    return;
  }

  selectedFile = file;

  const fileNameBox = $('fileName') \vert{}\vert{}$('fileStatus');
  if (fileNameBox) {
    fileNameBox.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  }

  if (loadButton) loadButton.disabled = false;

  setStatus(
    extension === 'mcworld'
      ? 'mcworldファイルを選択しました。3D表示を開始できます。'
      : 'ZIPファイルを選択しました。Minecraftワールド形式か確認して読み込みます。',
    'success'
  );
}

if (fileInput) {
  fileInput.addEventListener('change', (event) => {
    chooseFile(event.currentTarget.files?.[0]);
  });
}

if (dropzone) {
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput?.click();
    }
  });

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
    });
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    chooseFile(event.dataTransfer?.files?.[0]);
  });
}

if (loadButton) {
  loadButton.addEventListener('click', () => {
    loadWorld();
  });
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

  if (!viewport) throw new Error('3D表示領域 viewport がHTMLにありません。');

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#f7faf9');

  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 10000);
  camera.position.set(90, 75, 90);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance'
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(Math.max(1, viewport.clientWidth), Math.max(1, viewport.clientHeight));
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

// 堅牢なNBTパーサの再構築
function parseNbtCompound(bytes, state) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const readU8 = () => {
    if (state.p >= bytes.length) throw new Error('NBTデータが終端に達しました');
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
    return v.toString();
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
    if (state.p + length > bytes.length) throw new Error('NBT文字列の長さが不正です');
    const s = new TextDecoder().decode(bytes.subarray(state.p, state.p + length));
    state.p += length;
    return s;
  };

  const parseTagPayload = (type, depth = 0) => {
    if (depth > 50) throw new Error('NBTの階層が深すぎます');

    switch (type) {
      case 1: return (readU8() << 24) >> 24;
      case 2: return readI16();
      case 3: return readI32();
      case 4: return readI64();
      case 5: return readF32();
      case 6: return readF64();
      case 7: {
        const n = readI32();
        if (n < 0 || state.p + n > bytes.length) throw new Error('ByteArrayの長さが不正です');
        const a = bytes.slice(state.p, state.p + n);
        state.p += n;
        return a;
      }
      case 8: return readString();
      case 9: {
        const childType = readU8();
        const n = readI32();
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(parseTagPayload(childType, depth + 1));
        return arr;
      }
      case 10: {
        const obj = {};
        while (state.p < bytes.length) {
          const t = readU8();
          if (t === 0) break;
          const name = readString();
          obj[name] = parseTagPayload(t, depth + 1);
        }
        return obj;
      }
      case 11: {
        const n = readI32();
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(readI32());
        return arr;
      }
      case 12: {
        const n = readI32();
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(readI64());
        return arr;
      }
      default:
        throw new Error(`未対応のNBTタグタイプ: ${type}`);
    }
  };

  const rootType = readU8();
  if (rootType !== 10) throw new Error('ルートタグがCompoundではありません');
  readString(); // ルート名
  return parseTagPayload(10);
}

function readPalette(bytes, cursor) {
  const state = { p: cursor };
  const palette = parseNbtCompound(bytes, state);
  return { palette, cursor: state.p };
}

function parseStorage(bytes, cursor) {
  if (cursor >= bytes.length) throw new Error('ストレージデータが不足しています');

  const header = bytes[cursor++];
  const bits = header >> 1;

  let indices = null;
  let palette = [];

  if (bits === 0) {
    const res = readPalette(bytes, cursor);
    palette = [res.palette];
    cursor = res.cursor;
  } else {
    const perWord = Math.floor(32 / bits);
    const wordCount = Math.ceil(4096 / perWord);

    if (cursor + wordCount * 4 + 4 > bytes.length) {
      throw new Error('ブロックインデックスの領域が不足しています');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const words = new Uint32Array(wordCount);
    for (let i = 0; i < wordCount; i++) {
      words[i] = view.getUint32(cursor + i * 4, true);
    }
    cursor += wordCount * 4;

    indices = new Uint16Array(4096);
    const mask = (1 << bits) - 1;
    for (let i = 0; i < 4096; i++) {
      const wordIdx = Math.floor(i / perWord);
      const bitIdx = (i % perWord) * bits;
      indices[i] = (words[wordIdx] >>> bitIdx) & mask;
    }

    if (cursor + 4 > bytes.length) throw new Error('パレット数データがありません');
    const count = view.getInt32(cursor, true);
    cursor += 4;

    if (count < 0 || count > 65536) throw new Error(`パレット数が異常です: ${count}`);

    for (let i = 0; i < count; i++) {
      const res = readPalette(bytes, cursor);
      palette.push(res.palette);
      cursor = res.cursor;
    }
  }

  return { indices, palette, cursor };
}

function parseSubchunk(bytes, keyY) {
  if (!bytes || bytes.length < 2) return null;

  const version = bytes[0];
  if (version !== 8 && version !== 9) return { unsupported: version };

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

function paletteName(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.name || entry?.Name || 'unknown';
}

function blockColor(name) {
  const n = (name || '').replace('minecraft:', '');

  if (n.includes('water')) return 0x5a9fe8;
  if (n.includes('lava') || n.includes('magma')) return 0xe77935;
  if (n.includes('grass') || n.includes('leaves') || n.includes('moss') || n.includes('fern')) {
    return n.includes('leaves') ? 0x4e9a53 : 0x70ad59;
  }
  if (n.includes('dirt') || n.includes('mud') || n.includes('farmland')) return 0x8b6548;
  if (n.includes('sand') || n.includes('sandstone')) return 0xd9c58b;
  if (n.includes('snow') || n.includes('quartz') || n.includes('calcite')) return 0xe5e9e8;
  if (n.includes('stone') || n.includes('deepslate') || n.includes('andesite') || n.includes('granite')) return 0x858b90;
  if (n.includes('log') || n.includes('wood') || n.includes('planks') || n.includes('stem')) return 0x9b7049;
  if (n.includes('brick') || n.includes('terracotta')) return 0xb96e54;
  if (n.includes('glass')) return 0x9bd8d9;
  if (n.includes('iron') || n.includes('metal')) return 0xb8c1c7;
  if (n.includes('gold')) return 0xe3bf4f;
  if (n.includes('obsidian') || n.includes('coal')) return 0x45434f;
  if (n.includes('flower') || n.includes('rose')) return 0xd88bb5;

  return 0x9da8a0;
}

function isTransparentLike(name) {
  return isAir(name) ||
    /water|lava|glass|leaves|flower|tallgrass|short_grass|fern|vine|torch|rail|ladder|fire|snow_layer|carpet|button|plate/.test(name || '');
}

function blockKey(x, y, z) {
  return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
}

async function loadWorld() {
  if (!selectedFile) {
    if (fileInput && fileInput.files && fileInput.files[0]) {
      selectedFile = fileInput.files[0];
    } else {
      setStatus('先に .mcworld ファイルを選択してください。', 'error');
      return;
    }
  }

  loadButton.disabled = true;
  $('emptyState')?.classList.add('hidden');

  setLoading(true, 'ワールドを解析中…', 'LevelDBからデータを読み込んでいます。');
  setStatus('LevelDBを読み込んでいます…');

  if ($('chunkCount'))$('chunkCount').textContent = '…';
  if ($('blockCount'))$('blockCount').textContent = '…';
  if ($('renderCount'))$('renderCount').textContent = '…';

  try {
    initScene();

    const { readMcworld } = await import(
      'https://cdn.jsdelivr.net/npm/mcbe-leveldb-reader@5.0.1/+esm'
    );

    const entries = await readMcworld(selectedFile);
    if (!(entries instanceof Map)) throw new Error('LevelDBの読み込み結果が不正です');

    setLoading(true, 'サブチャンクを解析中…', `${entries.size.toLocaleString()} 個のキーをスキャン中…`);
    setStatus(`${entries.size.toLocaleString()} 個のキーを取得。サブチャンクを抽出しています…`);

    const subs = [];
    for (const [key, entry] of entries) {
      const len = key.length;
      if ((len !== 10 && len !== 14) || keyByte(key, len - 2) !== 0x2f) continue;

      const x = int32LEFromKey(key, 0);
      const z = int32LEFromKey(key, 4);
      const dim = len === 14 ? int32LEFromKey(key, 8) : 0;
      const y = signedByte(keyByte(key, len - 1));

      if (dim !== 0) continue;
      if (entry?.value instanceof Uint8Array) {
        subs.push({ x, z, y, bytes: entry.value });
      }
    }

    if (!subs.length) {
      throw new Error('有効なサブチャンクが見つかりませんでした。');
    }

    const blockMap = new Map();
    let parsedCount = 0;
    let unsupported = 0;
    let totalBlocksFound = 0;

    for (let si = 0; si < subs.length; si++) {
      const sub = subs[si];
      let parsed;

      try {
        parsed = parseSubchunk(sub.bytes, sub.y);
      } catch (e) {
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
        const ix = i >> 8;
        const iz = (i >> 4) & 15;
        const iy = i & 15;

        const nameAt = (layer) => {
          if (!layer) return '';
          const idx = layer.indices ? layer.indices[i] : 0;
          return paletteName(layer.palette[idx]);
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

        blockMap.set(blockKey(wx, wy, wz), { x: wx, y: wy, z: wz, name });
        totalBlocksFound++;
      }

      if (si % 30 === 0) {
        if ($('loadingText')) {$('loadingText').textContent = `サブチャンク処理中: ${si + 1} / ${subs.length} · ブロック ${totalBlocksFound.toLocaleString()}`;
        }
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (!blockMap.size) {
      throw new Error('ブロックデータを復元できませんでした。');
    }

    setLoading(true, '3Dモデルを描画中…', `${totalBlocksFound.toLocaleString()} 個のブロック表面を最適化しています。`);
    await new Promise(r => setTimeout(r, 0));

    const renderedCount = await renderBlocks(blockMap);

    if ($('chunkCount'))$('chunkCount').textContent = parsedCount.toLocaleString();
    if ($('blockCount'))$('blockCount').textContent = totalBlocksFound.toLocaleString();
    if ($('renderCount'))$('renderCount').textContent = renderedCount.toLocaleString();

    if ($('viewerHint'))$('viewerHint').textContent = `${selectedFile.name} · Overworld`;
    if ($('dimensionLabel'))$('dimensionLabel').textContent = 'Overworld';

    setStatus('読み込みが完了しました。マウスや指で視点を操作できます。', 'success');
    setLoading(false);
  } catch (error) {
    console.error(error);
    setLoading(false);
    $('emptyState')?.classList.remove('hidden');
    setStatus(`エラー: ${error?.message || error}`, 'error');
  } finally {
    loadButton.disabled = !selectedFile;
  }
}

async function renderBlocks(blockMap) {
  while (worldGroup.children.length) {
    const child = worldGroup.children[0];
    worldGroup.remove(child);
    child.geometry?.dispose();
    if (Array.isArray(child.material)) {
      child.material.forEach(m => m.dispose());
    } else {
      child.material?.dispose();
    }
  }

  const neighbors = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1]
  ];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const b of blockMap.values()) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.z < minZ) minZ = b.z;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
    if (b.z > maxZ) maxZ = b.z;
  }

  const geometry = new THREE.BoxGeometry(0.985, 0.985, 0.985);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0
  });

  const BATCH_SIZE = 16000;
  let batch = [];
  let renderedCount = 0;
  let processedCount = 0;

  function flushBatch(items) {
    if (!items.length) return;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      dummy.position.set(b.x, b.y, b.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.setHex(blockColor(b.name));
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    worldGroup.add(mesh);
    renderedCount += items.length;
  }

  for (const b of blockMap.values()) {
    let visible = false;
    for (let i = 0; i < 6; i++) {
      const [dx, dy, dz] = neighbors[i];
      if (!blockMap.has(blockKey(b.x + dx, b.y + dy, b.z + dz))) {
        visible = true;
        break;
      }
    }

    if (visible) batch.push(b);
    processedCount++;

    if (batch.length >= BATCH_SIZE) {
      flushBatch(batch);
      batch = [];
      if ($('loadingText')) {$('loadingText').textContent = `描画中… ${processedCount.toLocaleString()} / ${blockMap.size.toLocaleString()}`;
      }
      await new Promise(r => requestAnimationFrame(r));
    }
  }

  if (batch.length) flushBatch(batch);

  if (!renderedCount) {
    geometry.dispose();
    material.dispose();
    throw new Error('描画対象のブロックが見つかりませんでした。');
  }

  const center = new THREE.Vector3(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );
  worldGroup.position.set(-center.x, -center.y, -center.z);

  const size = Math.max(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1, 20);
  const distance = size * 1.2 + 25;

  camera.position.set(distance, distance * 0.78, distance);
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
  return renderedCount;
}
