/**
 * Enregistreur vocal (MediaRecorder) avec waveform temps réel.
 * Formats : Opus/WebM (Chrome, Firefox, Android) ou AAC/MP4 (Safari, iOS).
 */

export interface RecordingResult {
  blob: Blob;
  duration: number;
  waveform: number[];
  mime: string;
}

export function recordingSupported(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm',
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return '';
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: number | null = null;
  private startedAt = 0;
  private waveform: number[] = [];
  private mime = '';
  private lastSample = 0;
  private cancelled = false;

  async start(): Promise<void> {
    if (!recordingSupported()) throw new Error('L’enregistrement audio n’est pas disponible sur cet appareil.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.mime = pickMime();
    const options: MediaRecorderOptions = this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : {};
    this.recorder = new MediaRecorder(this.stream, options);
    this.chunks = [];
    this.waveform = [];
    this.cancelled = false;
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.setupAnalyser();
  }

  private setupAnalyser() {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaStreamSource(this.stream!);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const data = new Uint8Array(this.analyser.fftSize);
      this.lastSample = 0;
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.max(4, Math.min(100, Math.round(rms * 260)));
        const now = performance.now();
        if (now - this.lastSample > 90) {
          this.waveform.push(level);
          this.lastSample = now;
        }
        this.timer = window.setTimeout(tick, 80);
      };
      tick();
    } catch {
      /* waveform optionnelle */
    }
  }

  elapsed(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  waveformLevel(): number {
    return this.waveform.length ? this.waveform[this.waveform.length - 1] : 4;
  }

  async stop(): Promise<RecordingResult> {
    if (!this.recorder) throw new Error('Aucun enregistrement en cours.');
    const duration = Math.max(0.3, this.elapsed());
    const recorder = this.recorder;
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      recorder.stop();
    });
    this.cleanup();
    const waveform = downsample(this.waveform, 48);
    return { blob, duration, waveform, mime: this.mime || blob.type || 'audio/webm' };
  }

  cancel(): void {
    this.cancelled = true;
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.cleanup();
  }

  private cleanup() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') void this.audioCtx.close();
    this.audioCtx = null;
    this.recorder = null;
  }
}

function downsample(values: number[], size: number): number[] {
  if (values.length <= size) return values.length ? values : [12];
  const step = values.length / size;
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = start; j < end && j < values.length; j++) max = Math.max(max, values[j]);
    out.push(max);
  }
  return out;
}
