
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
let isLoading = false;
let scene, camera, renderer, controls, worldGroup, resizeObserver;
let initialCamera = null;
let coordinateReadout = null;
let raycaster = null;
let pointerNdc = null;

function setStatus(message, type = '') {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
}

function setLoading(
  show,
  title = '読み込み中…',
  message = 'ワールドのデータを確認しています。'
) {
  loading.classList.toggle('hidden', !show);
  $('loadingTitle').textContent = title;
  $('loadingText').textContent = message;
}

function chooseFile(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.mcworld')) {
    selectedFile = null;
    $('fileName').textContent =
      `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    loadButton.disabled = true;
    fileInput.value = '';
    setStatus(
      '拡張子が .mcworld のファイルを選択してください。',
      'error'
    );
    return;
  }

  selectedFile = file;

  $('fileName').textContent =
    `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;

  loadButton.disabled = isLoading;
  setStatus('ファイルを選択しました。3D表示を開始できます。');
}

fileInput.addEventListener('change', () => {
  chooseFile(fileInput.files?.[0]);
});

dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
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

loadButton.addEventListener('click', loadWorld);
$('resetView').addEventListener('click', resetCamera);

$('fullscreen').addEventListener('click', () => {
  document.body.classList.toggle('viewer-fullscreen');
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.body.classList.remove('viewer-fullscreen');
  }
});

function initScene() {
  if (renderer) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#f7faf9');

  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 10000);
  camera.position.set(90, 75, 90);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false
  });

  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, 1.8)
  );

  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  viewport.appendChild(renderer.domElement);

  coordinateReadout = document.createElement('div');
  coordinateReadout.textContent =
    '座標: ブロックにカーソルを合わせる';

  Object.assign(coordinateReadout.style, {
    position: 'absolute',
    left: '12px',
    bottom: '12px',
    zIndex: '5',
    padding: '7px 10px',
    borderRadius: '8px',
    background: 'rgba(255,255,255,0.92)',
    color: '#25312c',
    border: '1px solid rgba(30,50,40,0.14)',
    font: '12px/1.4 system-ui, sans-serif',
    pointerEvents: 'none',
    maxWidth: 'calc(100% - 24px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  });

  if (getComputedStyle(viewport).position === 'static') {
    viewport.style.position = 'relative';
  }

  viewport.appendChild(coordinateReadout);

  raycaster = new THREE.Raycaster();
  raycaster.params.Mesh.threshold = 0.1;
  pointerNdc = new THREE.Vector2();

  renderer.domElement.addEventListener(
    'pointermove',
    updateHoveredCoordinate,
    { passive: true }
  );

  renderer.domElement.addEventListener(
    'pointerup',
    updateHoveredCoordinate,
    { passive: true }
  );

  renderer.domElement.addEventListener(
    'pointerleave',
    () => {
      if (coordinateReadout) {
        coordinateReadout.textContent =
          '座標: ブロックにカーソルを合わせる';
      }
    },
    { passive: true }
  );

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

  resizeObserver = new ResizeObserver(() => resizeRenderer());
  resizeObserver.observe(viewport);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

function resizeRenderer() {
  if (!renderer || !camera) return;

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

function updateHoveredCoordinate(event) {
  if (
    !renderer ||
    !camera ||
    !worldGroup ||
    !raycaster ||
    !pointerNdc ||
    !coordinateReadout ||
    !worldGroup.children.length
  ) {
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();

  if (!rect.width || !rect.height) return;

  pointerNdc.x =
    ((event.clientX - rect.left) / rect.width) * 2 - 1;

  pointerNdc.y =
    -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNdc, camera);

  const hits = raycaster.intersectObjects(
    worldGroup.children,
    false
  );

  const hit = hits.find(
    item => item.instanceId !== undefined
  );

  if (!hit) {
    coordinateReadout.textContent =
      '座標: ブロックにカーソルを合わせる';
    return;
  }

  const matrix = new THREE.Matrix4();
  hit.object.getMatrixAt(hit.instanceId, matrix);

  const position = new THREE.Vector3()
    .setFromMatrixPosition(matrix);

  coordinateReadout.textContent =
    `座標 X ${Math.round(position.x)} · ` +
    `Y ${Math.round(position.y)} · ` +
    `Z ${Math.round(position.z)}`;
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

        if (n < 0 || n > 10000000) {
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

      indices[i] =
        (word >>> ((i % perWord) * bits)) & mask;
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

  return {
    indices,
    palette,
    cursor
  };
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

  if (storageCount < 1 || storageCount > 8) {
    return null;
  }

  const layers = [];

  for (let layer = 0; layer < storageCount; layer++) {
    const storage = parseStorage(bytes, cursor);

    layers.push(storage);
    cursor = storage.cursor;
  }

  return {
    subY,
    layers
  };
}

function paletteName(paletteEntry) {
  if (typeof paletteEntry === 'string') {
    return paletteEntry;
  }

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

  if (
    n.includes('dirt') ||
    n.includes('mud') ||
    n.includes('farmland') ||
    n.includes('podzol')
  ) {
    return 0x8b6548;
  }

  if (
    n.includes('sand') ||
    n.includes('sandstone') ||
    n.includes('end_stone')
  ) {
    return 0xd9c58b;
  }

  if (
    n.includes('snow') ||
    n.includes('quartz') ||
    n.includes('calcite') ||
    n.includes('diorite')
  ) {
    return 0xe5e9e8;
  }

  if (
    n.includes('stone') ||
    n.includes('deepslate') ||
    n.includes('andesite') ||
    n.includes('granite') ||
    n.includes('tuff')
  ) {
    return 0x858b90;
  }

  if (
    n.includes('log') ||
    n.includes('wood') ||
    n.includes('planks') ||
    n.includes('stem') ||
    n.includes('hyphae')
  ) {
    return 0x9b7049;
  }

  if (
    n.includes('brick') ||
    n.includes('terracotta') ||
    n.includes('copper')
  ) {
    return 0xb96e54;
  }

  if (n.includes('glass')) return 0x9bd8d9;

  if (
    n.includes('wool') ||
    n.includes('concrete') ||
    n.includes('shulker')
  ) {
    return 0xb3a5d8;
  }

  if (
    n.includes('iron') ||
    n.includes('chain') ||
    n.includes('metal')
  ) {
    return 0xb8c1c7;
  }

  if (n.includes('gold')) return 0xe3bf4f;

  if (
    n.includes('diamond') ||
    n.includes('prismarine')
  ) {
    return 0x59c5ad;
  }

  if (
    n.includes('coal') ||
    n.includes('obsidian') ||
    n.includes('blackstone')
  ) {
    return 0x45434f;
  }

  if (
    n.includes('flower') ||
    n.includes('tulip') ||
    n.includes('rose') ||
    n.includes('torchflower')
  ) {
    return 0xd88bb5;
  }

  return 0x9da8a0;
}

function isTransparentLike(name) {
  return isAir(name) ||
    /water|lava|glass|leaves|flower|tallgrass|short_grass|fern|vine|torch|rail|ladder|seagrass|kelp|fire|snow_layer|carpet|button|pressure_plate/.test(name || '');
}

let sharedCubeGeometry = null;
let sharedCubeMaterial = null;

const BATCH_SIZE = 12000;
const YIELD_EVERY_SUBCHUNKS = 12;

function chunkKey(x, y, z) {
  return `${x},${y},${z}`;
}

function localIndex(x, y, z) {
  return x * 256 + z * 16 + y;
}

function packBlock(name) {
  if (isAir(name)) return 0;

  return (
    blockColor(name) |
    (isTransparentLike(name) ? 0x80000000 : 0)
  ) >>> 0;
}

function packedPalette(layer) {
  if (!layer) return null;

  return layer.palette.map((entry) =>
    packBlock(paletteName(entry))
  );
}

function clearWorldMeshes() {
  if (!worldGroup) return;

  for (const child of worldGroup.children) {
    if (child.isInstancedMesh) {
      child.dispose?.();
    }
  }

  worldGroup.clear();
}

function createSharedGeometry() {
  if (!sharedCubeGeometry) {
    sharedCubeGeometry = new THREE.BoxGeometry(
      0.985,
      0.985,
      0.985
    );
  }

  if (!sharedCubeMaterial) {
    sharedCubeMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.0
    });
  }
}

async function loadWorld() {
  if (!selectedFile || isLoading) return;

  const fileToLoad = selectedFile;
  isLoading = true;
  loadButton.disabled = true;
  $('emptyState').classList.add('hidden');

  setLoading(
    true,
    'ワールドを解析中…',
    'LevelDBとチャンクデータを読み込んでいます。大きなワールドでは時間がかかります。'
  );

  setStatus('LevelDBを読み込んでいます…');

  $('chunkCount').textContent = '…';
  $('blockCount').textContent = '…';
  $('renderCount').textContent = '…';

  try {
    initScene();
    clearWorldMeshes();

    const entries = await readMcworld(fileToLoad);

    if (!(entries instanceof Map)) {
      throw new Error('LevelDBの読み込み結果が想定と異なります');
    }

    setLoading(
      true,
      'チャンクを解析中…',
      `${entries.size.toLocaleString()} 個のLevelDBキーを確認しました。`
    );

    setStatus(
      `${entries.size.toLocaleString()} 個のLevelDBキーを取得。サブチャンクを解析しています…`
    );

    const chunks = new Map();

    let parsedCount = 0;
    let blockCount = 0;
    let unsupported = 0;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;

    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    let processedSubchunks = 0;

    const subs = [];

    for (const [key, entry] of entries) {
      const length = key.length;

      if (
        (length !== 10 && length !== 14) ||
        keyByte(key, length - 2) !== 0x2f
      ) {
        continue;
      }

      const cx = int32LEFromKey(key, 0);
      const cz = int32LEFromKey(key, 4);

      const dimension = length === 14
        ? int32LEFromKey(key, 8)
        : 0;

      const keyY = signedByte(keyByte(key, length - 1));

      if (
        dimension !== 0 ||
        !(entry?.value instanceof Uint8Array)
      ) {
        continue;
      }

      subs.push({
        key,
        cx,
        cz,
        keyY,
        bytes: entry.value
      });
    }

    if (typeof entries.clear === 'function') {
      entries.clear();
    }

    if (!subs.length) {
      throw new Error(
        'サブチャンクが見つかりません。対応するBedrock .mcworldか確認してください。'
      );
    }

    for (const sub of subs) {
      const { key, cx, cz, keyY, bytes } = sub;

      processedSubchunks++;

      let parsed;

      try {
        parsed = parseSubchunk(bytes, keyY);
      } catch (error) {
        console.warn('Subchunk parse failed:', key, error);
        continue;
      }

      if (!parsed || parsed.unsupported) {
        if (parsed?.unsupported) unsupported++;
        continue;
      }

      const solid = parsed.layers[0];
      const fluid = parsed.layers[1];

      const solidPalette = packedPalette(solid);
      const fluidPalette = packedPalette(fluid);

      const voxels = new Uint32Array(4096);
      let chunkBlocks = 0;

      for (let i = 0; i < 4096; i++) {
        const solidIndex = solid?.indices
          ? solid.indices[i]
          : 0;

        let packed = solidPalette?.[solidIndex] || 0;

        if (!packed && fluidPalette) {
          const fluidIndex = fluid?.indices
            ? fluid.indices[i]
            : 0;

          packed = fluidPalette[fluidIndex] || 0;
        }

        if (!packed) continue;

        voxels[i] = packed;
        chunkBlocks++;
        blockCount++;

        const lx = Math.floor(i / 256);
        const lz = Math.floor(i / 16) % 16;
        const ly = i % 16;

        const wx = cx * 16 + lx;
        const wy = parsed.subY * 16 + ly;
        const wz = cz * 16 + lz;

        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;

        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
      }

      if (chunkBlocks) {
        chunks.set(
          chunkKey(cx, parsed.subY, cz),
          {
            cx,
            cy: parsed.subY,
            cz,
            voxels
          }
        );

        parsedCount++;
      }

      if (processedSubchunks % YIELD_EVERY_SUBCHUNKS === 0) {
        $('loadingText').textContent =
          `サブチャンク ${processedSubchunks.toLocaleString()} · ` +
          `ブロック ${blockCount.toLocaleString()} · メモリ節約モード`;

        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    subs.length = 0;

    if (!blockCount || !chunks.size) {
      throw new Error(
        'ブロックを復元できませんでした。旧形式のワールドか、未対応のチャンク形式の可能性があります。'
      );
    }

    setLoading(
      true,
      '3Dモデルを作成中…',
      `${blockCount.toLocaleString()} 個のブロックをコンパクト形式で保持しています。表面を抽出しています。`
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    const renderedCount = await renderCompactChunks(chunks, {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ
    });

    $('chunkCount').textContent = parsedCount.toLocaleString();
    $('blockCount').textContent = blockCount.toLocaleString();
    $('renderCount').textContent = renderedCount.toLocaleString();

    $('viewerHint').textContent =
      `${fileToLoad.name} · Overworld`;

    $('dimensionLabel').textContent = 'Overworld';

    const warnings = [];

    if (unsupported) {
      warnings.push(
        `${unsupported} 個の未対応形式サブチャンクをスキップしました`
      );
    }

    const anotherFileSelected =
      selectedFile && selectedFile !== fileToLoad;
    const completionMessage = anotherFileSelected
      ? `${fileToLoad.name} の読み込み完了。現在表示中です。` +
        `${selectedFile.name} は選択中です。「3D描画」で読み込めます。`
      : `読み込み完了。${
          warnings.length
            ? warnings.join('。') + '。'
            : 'マウスや指で回転・ズームできます。'
        }`;

    setStatus(completionMessage, 'success');

    setLoading(false);
  } catch (error) {
    console.error(error);

    setLoading(false);
    $('emptyState').classList.remove('hidden');

    setStatus(
      `${fileToLoad.name} の読み込みエラー: ${error?.message || error}`,
      'error'
    );
  } finally {
    isLoading = false;
    loadButton.disabled = !selectedFile;
  }
}

function getVoxel(chunks, chunk, lx, ly, lz) {
  if (
    lx >= 0 && lx < 16 &&
    ly >= 0 && ly < 16 &&
    lz >= 0 && lz < 16
  ) {
    return chunk.voxels[localIndex(lx, ly, lz)];
  }

  let nx = chunk.cx;
  let ny = chunk.cy;
  let nz = chunk.cz;

  if (lx < 0) {
    nx--;
    lx = 15;
  } else if (lx > 15) {
    nx++;
    lx = 0;
  }

  if (ly < 0) {
    ny--;
    ly = 15;
  } else if (ly > 15) {
    ny++;
    ly = 0;
  }

  if (lz < 0) {
    nz--;
    lz = 15;
  } else if (lz > 15) {
    nz++;
    lz = 0;
  }

  const neighbor = chunks.get(chunkKey(nx, ny, nz));

  return neighbor
    ? neighbor.voxels[localIndex(lx, ly, lz)]
    : 0;
}

function faceIsVisible(chunks, chunk, x, y, z, dx, dy, dz) {
  const packed = getVoxel(
    chunks,
    chunk,
    x + dx,
    y + dy,
    z + dz
  );

  return packed === 0 || (packed >>> 31) === 1;
}

async function renderCompactChunks(chunks, bounds) {
  clearWorldMeshes();
  createSharedGeometry();

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  const neighbors = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ];

  let rendered = 0;
  let batchMesh = null;
  let batchIndex = 0;
  let scanned = 0;

  const startBatch = () => {
    batchMesh = new THREE.InstancedMesh(
      sharedCubeGeometry,
      sharedCubeMaterial,
      BATCH_SIZE
    );

    batchMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    batchIndex = 0;
  };

  const finishBatch = () => {
    if (!batchMesh || batchIndex === 0) return;

    batchMesh.count = batchIndex;
    batchMesh.instanceMatrix.needsUpdate = true;

    if (batchMesh.instanceColor) {
      batchMesh.instanceColor.needsUpdate = true;
    }

    worldGroup.add(batchMesh);
    batchMesh = null;
  };

  startBatch();

  for (const chunk of chunks.values()) {
    for (let i = 0; i < chunk.voxels.length; i++) {
      const packed = chunk.voxels[i];

      if (!packed) continue;

      const x = Math.floor(i / 256);
      const z = Math.floor(i / 16) % 16;
      const y = i % 16;

      let visible = false;

      for (const [dx, dy, dz] of neighbors) {
        if (
          faceIsVisible(
            chunks,
            chunk,
            x,
            y,
            z,
            dx,
            dy,
            dz
          )
        ) {
          visible = true;
          break;
        }
      }

      if (!visible) continue;

      const wx = chunk.cx * 16 + x;
      const wy = chunk.cy * 16 + y;
      const wz = chunk.cz * 16 + z;

      dummy.position.set(wx, wy, wz);
      dummy.updateMatrix();

      batchMesh.setMatrixAt(batchIndex, dummy.matrix);

      color.setHex(packed & 0x00ffffff);
      batchMesh.setColorAt(batchIndex, color);

      batchIndex++;
      rendered++;
      scanned++;

      if (batchIndex >= BATCH_SIZE) {
        finishBatch();
        startBatch();
      }

      if (scanned % 50000 === 0) {
        $('loadingText').textContent =
          `表面を抽出中… ${rendered.toLocaleString()} 個を描画準備`;

        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    $('loadingText').textContent =
      `表面を抽出中… ${rendered.toLocaleString()} 個を描画準備`;

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  finishBatch();

  const center = new THREE.Vector3(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2
  );

  worldGroup.position.set(
    -center.x,
    -center.y,
    -center.z
  );

  const size = Math.max(
    bounds.maxX - bounds.minX + 1,
    bounds.maxY - bounds.minY + 1,
    bounds.maxZ - bounds.minZ + 1,
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
  controls.minDistance = Math.max(3, size * 0.025);
  controls.maxDistance = Math.max(1000, size * 8);
  controls.update();

  initialCamera = {
    position: camera.position.clone(),
    target: controls.target.clone()
  };

  $('emptyState').classList.add('hidden');

  return rendered;
}
