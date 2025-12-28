<template>
  <div class="parameter-panel">
    <div class="tool-area">
      パラメータ
      <ParameterPanelEditTargetSwitcher :editTarget :changeEditTarget />
    </div>
    <div class="axis-area"></div>
    <div v-if="editTarget === 'PHONEME_TIMING'" class="parameter-area">
      <SequencerParameterGrid
        class="parameter-grid"
        :offsetX="props.viewportInfo.offsetX"
      />
      <SequencerWaveform
        class="waveform"
        :offsetX="props.viewportInfo.offsetX"
      />
      <SequencerNoteTimings
        class="note-timings"
        :offsetX="props.viewportInfo.offsetX"
        :offsetY="props.viewportInfo.offsetY"
      />
      <SequencerPhonemeTimings
        class="phoneme-timings"
        :offsetX="props.viewportInfo.offsetX"
        :offsetY="props.viewportInfo.offsetY"
      />
    </div>
    <div v-if="editTarget === 'VOLUME'" class="parameter-area">
      <SequencerVolumeEditor :playheadTicks :tempos :tpqn :zoomX :zoomY />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import SequencerVolumeEditor from "@/components/Sing/SequencerVolumeEditor.vue";
import SequencerParameterGrid from "@/components/Sing/SequencerParameterGrid.vue";
import SequencerWaveform from "@/components/Sing/SequencerWaveform.vue";
import SequencerPhonemeTimings from "@/components/Sing/SequencerPhonemeTimings.vue";
import SequencerNoteTimings from "@/components/Sing/SequencerNoteTimings.vue";
import type { ViewportInfo } from "@/sing/viewHelper";
import { useStore } from "@/store";
import { ParameterPanelEditTarget } from "@/store/type";
import ParameterPanelEditTargetSwitcher from "@/components/Sing/ParameterPanelEditTargetSwitcher.vue";

const store = useStore();

const playheadTicks = computed(() => store.getters.PLAYHEAD_POSITION);
const tempos = computed(() => store.state.tempos);
const tpqn = computed(() => store.state.tpqn);
const zoomX = computed(() => store.state.sequencerZoomX);
const zoomY = computed(() => store.state.sequencerZoomY);

const editTarget = computed(() => store.state.parameterPanelEditTarget);

const changeEditTarget = (editTarget: ParameterPanelEditTarget) => {
  void store.actions.SET_PARAMETER_PANEL_EDIT_TARGET({ editTarget });
};

const props = defineProps<{
  viewportInfo: ViewportInfo;
}>();
</script>

<style scoped lang="scss">
@use "@/styles/v2/variables" as vars;

.parameter-panel {
  position: relative;
  width: 100%;
  height: 100%;

  overflow: hidden;
  display: grid;
  grid-template-columns: 48px 1fr;
  grid-template-rows: 48px 1fr;
}

.tool-area {
  grid-column: 1 / 3;
  grid-row: 1;
  border-bottom: solid 1px var(--scheme-color-sing-piano-keys-right-border);

  display: flex;
  align-items: center;
  padding-left: 8px;
  column-gap: 8px;
}

.axis-area {
  grid-column: 1;
  grid-row: 2;
  border-right: solid 1px var(--scheme-color-sing-piano-keys-right-border);
}

.parameter-area {
  grid-column: 2;
  grid-row: 2;

  overflow: hidden;
  display: grid;
  grid-template-rows: 12px 26px 28px 1fr;
}

.parameter-grid {
  grid-column: 1;
  grid-row: 1 / 5;
}

.waveform {
  grid-column: 1;
  grid-row: 4 / 5;
}

.note-timings {
  grid-column: 1;
  grid-row: 2 / 3;
}

.phoneme-timings {
  grid-column: 1;
  grid-row: 1 / 5;
}
</style>
