<template>
  <div ref="canvasContainer" class="canvas-container">
    <canvas ref="canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onUnmounted, onMounted } from "vue";
import * as PIXI from "pixi.js";
import { useStore } from "@/store";
import { useMounted } from "@/composables/useMounted";
import { tickToBaseX } from "@/sing/viewHelper";
import { secondToTick } from "@/sing/domain";
import type { FramePhoneme } from "@/openapi";

const props = defineProps<{
  offsetX: number;
  offsetY: number;
}>();

const store = useStore();
const tpqn = computed(() => store.state.tpqn);
const isDark = computed(() => store.state.currentTheme === "Dark");
const selectedTrack = computed(() => store.getters.SELECTED_TRACK);

type ColorStyle = {
  moraFill: number;
  moraBorder: number;
  textFill: number;
};

type MoraTimingInfo = {
  startTick: number;
  endTick: number;
  phonemes: string[];
};

// NOTE: モーラの色をテーマに応じて定義
// ピアノロール上の未選択ノートと同じ色を使用（緑系）
const moraColorStyles: {
  light: ColorStyle;
  dark: ColorStyle;
} = {
  light: {
    moraFill: 0xf2fff5, // 明るい緑
    moraBorder: 0x7cb584, // 中間の緑
    textFill: 0x1a3d2e, // 暗い緑
  },
  dark: {
    moraFill: 0x5a7d65, // 暗い緑
    moraBorder: 0xa5c9ae, // 明るめの緑
    textFill: 0xe8f5eb, // 明るい緑がかった白
  },
};

const moraColors = computed(() =>
  isDark.value ? moraColorStyles.dark : moraColorStyles.light,
);

// NOTE: モーラテキストのスタイルをテーマに応じて定義
const moraTextStyles: {
  light: PIXI.TextStyle;
  dark: PIXI.TextStyle;
} = {
  light: new PIXI.TextStyle({ fill: "#252E26", fontSize: 14 }),
  dark: new PIXI.TextStyle({ fill: "#252E26", fontSize: 14 }),
};

const selectedTrackNotes = computed(() => {
  return selectedTrack.value?.notes ?? [];
});

const tempos = computed(() => store.state.tempos);
const selectedTrackId = computed(() => store.getters.SELECTED_TRACK_ID);

const moraTimings = computed(() => {
  const timingsMap = new Map<string, MoraTimingInfo>();

  // 選択されたトラックの全てのフレーズを処理
  for (const phrase of store.state.phrases.values()) {
    if (phrase.trackId !== selectedTrackId.value) {
      continue;
    }

    // このフレーズのクエリを取得
    if (phrase.queryKey == undefined) {
      continue;
    }
    const query = store.state.phraseQueries.get(phrase.queryKey);
    if (query == undefined) {
      continue;
    }

    // 全ての音素の累積フレーム位置を構築
    let cumulativeFrame = 0;
    const phonemePositions: {
      phoneme: FramePhoneme;
      startFrame: number;
      endFrame: number;
    }[] = [];

    for (const phoneme of query.phonemes) {
      phonemePositions.push({
        phoneme,
        startFrame: cumulativeFrame,
        endFrame: cumulativeFrame + phoneme.frameLength,
      });
      cumulativeFrame += phoneme.frameLength;
    }

    // noteIdごとに音素をグループ化してモーラのタイミングを計算
    const phonemesByNote = new Map<string, typeof phonemePositions>();
    for (const pos of phonemePositions) {
      if (pos.phoneme.noteId == undefined) {
        continue;
      }

      const noteId = pos.phoneme.noteId;
      let array = phonemesByNote.get(noteId);
      if (array == undefined) {
        array = [];
        phonemesByNote.set(noteId, array);
      }
      array.push(pos);
    }

    // 各ノート内のモーラのタイミングを計算
    for (const [noteId, positions] of phonemesByNote) {
      if (positions.length === 0) {
        continue; // 音素がない場合はスキップ
      }

      // 最初の音素と最後の音素を取得
      const firstPosition = positions[0];
      const lastPosition = positions[positions.length - 1];

      // フレーム位置を秒に変換
      const startSeconds =
        phrase.startTime + firstPosition.startFrame / query.frameRate;
      const endSeconds =
        phrase.startTime + lastPosition.endFrame / query.frameRate;

      // 秒をティックに変換
      const startTick = secondToTick(startSeconds, tempos.value, tpqn.value);
      const endTick = secondToTick(endSeconds, tempos.value, tpqn.value);

      // 音素のリストを抽出
      const phonemes = positions.map((pos) => pos.phoneme.phoneme);

      timingsMap.set(noteId, {
        startTick,
        endTick,
        phonemes,
      });
    }
  }

  return timingsMap;
});

const { mounted } = useMounted();

const canvasContainer = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
let resizeObserver: ResizeObserver | undefined;
let canvasWidth: number | undefined;
let canvasHeight: number | undefined;

let renderer: PIXI.Renderer | undefined;
let stage: PIXI.Container | undefined;
const graphics: PIXI.Graphics[] = [];
const texts: PIXI.Text[] = [];
const textContainersMap = new Map<PIXI.Text, PIXI.Container>();
const textMasksMap = new Map<PIXI.Text, PIXI.Graphics>();
let lastIsDark: boolean | undefined;
let requestId: number | undefined;
let renderInNextFrame = false;

const render = () => {
  if (renderer == undefined) {
    throw new Error("renderer is undefined.");
  }
  if (stage == undefined) {
    throw new Error("stage is undefined.");
  }
  if (canvasWidth == undefined) {
    throw new Error("canvasWidth is undefined.");
  }
  if (canvasHeight == undefined) {
    throw new Error("canvasHeight is undefined.");
  }

  const moraHeight = 32;
  const moraY = 16;

  const notes = selectedTrackNotes.value;
  const colors = moraColors.value;
  const currentTextStyle = isDark.value
    ? moraTextStyles.dark
    : moraTextStyles.light;

  // テーマが変更された場合、全てのテキスト関連オブジェクトをクリア
  if (lastIsDark != undefined && lastIsDark !== isDark.value) {
    for (const text of texts) {
      const container = textContainersMap.get(text);
      if (container != undefined) {
        stage.removeChild(container);
        container.destroy(true);
      }
    }
    texts.length = 0;
    textContainersMap.clear();
    textMasksMap.clear();
  }
  lastIsDark = isDark.value;

  let graphicsIndex = 0;
  let textIndex = 0;

  // モーラの位置情報を格納（マスク計算用）
  const moraPositions: { screenStartX: number; text: PIXI.Text }[] = [];

  // 各ノート内のモーラを描画
  for (const note of notes) {
    // 位置とサイズを計算
    // まずモーラのタイミングを取得を試みる
    const moraTiming = moraTimings.value.get(note.id);
    let baseStartX: number;
    let baseEndX: number;

    if (moraTiming != undefined) {
      // モーラのタイミングを使用
      baseStartX = tickToBaseX(moraTiming.startTick, tpqn.value);
      baseEndX = tickToBaseX(moraTiming.endTick, tpqn.value);
    } else {
      // 元の位置/長さにフォールバック
      baseStartX = tickToBaseX(note.position, tpqn.value);
      baseEndX = tickToBaseX(note.position + note.duration, tpqn.value);
    }

    const screenStartX = Math.round(
      baseStartX * store.state.sequencerZoomX - props.offsetX,
    );
    const screenEndX = Math.round(
      baseEndX * store.state.sequencerZoomX - props.offsetX,
    );
    const screenWidth = screenEndX - screenStartX;

    // 可視性をチェック（ビューポートカリング）
    const moraRight = screenStartX + screenWidth;
    if (screenWidth < 1 || moraRight < 0 || screenStartX > canvasWidth) {
      continue;
    }

    // グラフィックスを取得または作成
    if (graphicsIndex >= graphics.length) {
      const newGraphic = new PIXI.Graphics();
      stage.addChild(newGraphic);
      graphics.push(newGraphic);
    }
    const graphic = graphics[graphicsIndex];
    graphicsIndex++;

    // 長方形を描画（選択状態に関わらず同じ色）
    graphic.renderable = true;
    graphic.clear();
    graphic.lineStyle(1, colors.moraBorder, 1);
    graphic.beginFill(colors.moraFill, 1);
    graphic.drawRoundedRect(
      screenStartX - 0.5,
      moraY - 0.5,
      screenWidth,
      moraHeight,
      5,
    );
    graphic.endFill();

    // モーラの音素をテキストで描画
    if (moraTiming != undefined && moraTiming.phonemes.length > 0) {
      if (textIndex >= texts.length) {
        const newText = new PIXI.Text("", currentTextStyle);
        const container = new PIXI.Container();
        const mask = new PIXI.Graphics();

        container.mask = mask;
        container.addChild(newText);
        stage.addChild(container);
        texts.push(newText);
        textContainersMap.set(newText, container);
        textMasksMap.set(newText, mask);
      }
      const text = texts[textIndex];
      textIndex++;

      text.text = moraTiming.phonemes.join(" ");
      text.anchor.set(0, 0.5);

      const textContainer = textContainersMap.get(text);
      if (textContainer == undefined) {
        throw new Error("textContainer is undefined.");
      }
      textContainer.renderable = true;
      textContainer.x = screenStartX + 3;
      textContainer.y = moraY + moraHeight / 2;

      // 位置情報を記録（マスク計算用）
      moraPositions.push({ screenStartX: textContainer.x, text });
    }
  }

  // マスク処理：各テキストが次のテキストと被らないようにする
  for (let i = 0; i < moraPositions.length; i++) {
    const { screenStartX, text } = moraPositions[i];
    const textMask = textMasksMap.get(text);
    const textContainer = textContainersMap.get(text);

    if (textMask == undefined || textContainer == undefined) {
      continue;
    }

    // デフォルトのマスク幅
    let maskWidth = 36;

    // 次のテキストがある場合、その位置までに制限
    if (i + 1 < moraPositions.length) {
      const nextScreenStartX = moraPositions[i + 1].screenStartX;
      maskWidth = Math.min(maskWidth, nextScreenStartX - screenStartX);
    }

    const maskHeight = 36;

    textMask
      .clear()
      .beginFill(0xffffff)
      .drawRect(
        textContainer.x,
        textContainer.y - maskHeight / 2,
        maskWidth,
        maskHeight,
      )
      .endFill();
  }

  // 未使用のグラフィックスとテキストを非表示
  for (let i = graphicsIndex; i < graphics.length; i++) {
    graphics[i].renderable = false;
  }
  for (let i = textIndex; i < texts.length; i++) {
    const text = texts[i];
    const textContainer = textContainersMap.get(text);
    if (textContainer != undefined) {
      textContainer.renderable = false;
    }
  }

  renderer.render(stage);
};

// mountedをwatchしているので、onMountedの直後に必ず１回実行される
watch(
  [
    mounted,
    selectedTrackNotes,
    moraTimings,
    tpqn,
    () => store.state.phrases,
    () => store.state.phraseQueries,
  ],
  ([mounted]) => {
    if (mounted) {
      renderInNextFrame = true;
    }
  },
);

watch(isDark, () => {
  renderInNextFrame = true;
});

watch(
  () => [store.state.sequencerZoomX, props.offsetX],
  () => {
    renderInNextFrame = true;
  },
);

onMounted(() => {
  const canvasContainerElement = canvasContainer.value;
  const canvasElement = canvas.value;
  if (!canvasContainerElement) {
    throw new Error("canvasContainerElement is null.");
  }
  if (!canvasElement) {
    throw new Error("canvasElement is null.");
  }

  canvasWidth = canvasContainerElement.clientWidth;
  canvasHeight = canvasContainerElement.clientHeight;

  renderer = new PIXI.Renderer({
    view: canvasElement,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    width: canvasWidth,
    height: canvasHeight,
  });
  stage = new PIXI.Container();

  const callback = () => {
    if (renderInNextFrame) {
      render();
      renderInNextFrame = false;
    }
    requestId = window.requestAnimationFrame(callback);
  };
  requestId = window.requestAnimationFrame(callback);

  resizeObserver = new ResizeObserver(() => {
    if (renderer == undefined) {
      throw new Error("renderer is undefined.");
    }
    const canvasContainerWidth = canvasContainerElement.clientWidth;
    const canvasContainerHeight = canvasContainerElement.clientHeight;

    if (canvasContainerWidth > 0 && canvasContainerHeight > 0) {
      canvasWidth = canvasContainerWidth;
      canvasHeight = canvasContainerHeight;
      renderer.resize(canvasWidth, canvasHeight);
      renderInNextFrame = true;
    }
  });
  resizeObserver.observe(canvasContainerElement);
});

onUnmounted(() => {
  if (requestId != undefined) {
    window.cancelAnimationFrame(requestId);
  }
  for (const graphic of graphics) {
    stage?.removeChild(graphic);
    graphic.destroy();
  }
  for (const text of texts) {
    const container = textContainersMap.get(text);
    if (container != undefined) {
      stage?.removeChild(container);
      container.destroy(true);
    }
  }
  textContainersMap.clear();
  textMasksMap.clear();
  stage?.destroy(true);
  renderer?.destroy(true);
  resizeObserver?.disconnect();
});
</script>

<style scoped lang="scss">
.canvas-container {
  overflow: hidden;
  pointer-events: none;
  position: relative;

  contain: strict; // canvasのサイズが変わるのを無視する
}
</style>
