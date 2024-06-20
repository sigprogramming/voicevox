export function round(value: number, digits: number) {
  const powerOf10 = 10 ** digits;
  return Math.round(value * powerOf10) / powerOf10;
}

export function getLast<T>(array: T[]) {
  if (array.length === 0) {
    throw new Error("array.length is 0.");
  }
  return array[array.length - 1];
}

export function calculateDistanceFromPointToLine(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
) {
  const lineM = (p1.y - p0.y) / (p1.x - p0.x);
  return (
    Math.abs(lineM * p2.x - p2.y + p0.y - lineM * p0.x) /
    Math.sqrt(lineM ** 2 + 1)
  );
}

export class Interpolate {
  static linear(
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    x: number,
  ) {
    if (p1.x <= p0.x) {
      throw new Error("p1.x must be greater than p0.x.");
    }
    const m = (p1.y - p0.y) / (p1.x - p0.x);
    return p0.y + (x - p0.x) * m;
  }

  static cubicHermite(
    p0: { x: number; y: number },
    m0: number,
    p1: { x: number; y: number },
    m1: number,
    x: number,
  ) {
    const dx = p1.x - p0.x;
    const t = (x - p0.x) / dx;
    const h0 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h1 = t ** 3 - 2 * t ** 2 + t;
    const h2 = -2 * t ** 3 + 3 * t ** 2;
    const h3 = t ** 3 - t ** 2;
    return p0.y * h0 + m0 * dx * h1 + p1.y * h2 + m1 * dx * h3;
  }

  static catmullRom(points: { x: number; y: number }[], xValues: number[]) {
    if (points.length < 2) {
      throw new Error("points.length must be at least 2.");
    }
    const n = points.length;
    const firstP = points[0];
    const lastP = points[n - 1];

    const mValues: number[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[Math.min(n - 1, i + 1)];
      const m = (p1.y - p0.y) / (p1.x - p0.x);
      mValues.push(m);
    }

    const yValues: number[] = [];
    for (const x of xValues) {
      if (x < firstP.x) {
        const m = mValues[0];
        const y = firstP.y + (x - firstP.x) * m;
        yValues.push(y);
      } else if (x >= lastP.x) {
        const m = mValues[n - 1];
        const y = lastP.y + (x - lastP.x) * m;
        yValues.push(y);
      } else {
        for (let i = 0; i < n - 1; i++) {
          if (x < points[i + 1].x) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const m0 = mValues[i];
            const m1 = mValues[i + 1];
            const y = this.cubicHermite(p0, m0, p1, m1, x);
            yValues.push(y);
            break;
          }
        }
      }
    }
    return yValues;
  }

  static pchip(points: { x: number; y: number }[], xValues: number[]) {
    if (points.length < 2) {
      throw new Error("points.length must be at least 2.");
    }
    const n = points.length;
    const firstP = points[0];
    const lastP = points[n - 1];

    const mValues: number[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[Math.min(n - 1, i + 1)];
      const dx = p2.x - p0.x;
      const dy0 = p1.y - p0.y;
      const dy1 = p2.y - p1.y;
      const m = dy0 * dy1 <= 0 ? 0 : (dy0 + dy1) / dx;
      mValues.push(m);
    }
    for (let i = 0; i < n - 1; i++) {
      const m0 = mValues[i];
      const m1 = mValues[i + 1];
      const p0 = points[i];
      const p1 = points[i + 1];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      if (dy !== 0) {
        const d = dy / dx;
        const a = m0 / d;
        const b = m1 / d;
        const t = 3 / Math.sqrt(a * a + b * b);
        if (t < 1) {
          mValues[i] = t * a * d;
          mValues[i + 1] = t * b * d;
        }
      }
    }

    const yValues: number[] = [];
    for (const x of xValues) {
      if (x < firstP.x) {
        const m = mValues[0];
        const y = firstP.y + (x - firstP.x) * m;
        yValues.push(y);
      } else if (x >= lastP.x) {
        const m = mValues[n - 1];
        const y = lastP.y + (x - lastP.x) * m;
        yValues.push(y);
      } else {
        for (let i = 0; i < n - 1; i++) {
          if (x < points[i + 1].x) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const m0 = mValues[i];
            const m1 = mValues[i + 1];
            const y = this.cubicHermite(p0, m0, p1, m1, x);
            yValues.push(y);
            break;
          }
        }
      }
    }
    return yValues;
  }
}

export function differentiate(yValues: number[]) {
  const n = yValues.length;
  const diffArray: number[] = [];
  for (let i = 0; i < n; i++) {
    const y0 = yValues[Math.max(0, i - 1)];
    const y1 = yValues[Math.min(n - 1, i + 1)];
    diffArray.push((y1 - y0) / 2);
  }
  return diffArray;
}

export function iterativeEndPointFit(
  points: { x: number; y: number }[],
  epsilon: number,
) {
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].x > points[i].x) {
      throw new Error("Points must be sorted by x coordinate.");
    }
  }
  const markedPoints = [points[0], getLast(points)];
  const pointsWaitingToBeProcessed = [points];
  while (true) {
    const pointsToProcess = pointsWaitingToBeProcessed.pop();
    if (pointsToProcess == undefined) {
      break;
    }
    if (pointsToProcess.length <= 2) {
      continue;
    }
    const p0 = pointsToProcess[0];
    const p1 = getLast(pointsToProcess);
    let farthestPointIndex = 1;
    let farthestPointD = 0;
    for (let i = 1; i < pointsToProcess.length - 1; i++) {
      const p2 = pointsToProcess[i];
      const d = Math.abs(p2.y - Interpolate.linear(p0, p1, p2.x));
      if (d > farthestPointD) {
        farthestPointD = d;
        farthestPointIndex = i;
      }
    }
    if (farthestPointD >= epsilon) {
      const farthestPoint = pointsToProcess[farthestPointIndex];
      markedPoints.push(farthestPoint);
      const slicedPoints1 = pointsToProcess.slice(0, farthestPointIndex + 1);
      const slicedPoints2 = pointsToProcess.slice(
        farthestPointIndex,
        pointsToProcess.length,
      );
      pointsWaitingToBeProcessed.push(slicedPoints1);
      pointsWaitingToBeProcessed.push(slicedPoints2);
    }
  }
  return markedPoints.sort((a, b) => a.x - b.x);
}

function ceilToOdd(value: number) {
  return 1 + Math.ceil((value - 1) / 2) * 2;
}

function createGaussianKernel(sigma: number) {
  const kernelSize = ceilToOdd(sigma * 3);
  const center = Math.floor(kernelSize / 2);
  let kernel: number[] = [];
  let sum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const x = Math.abs(center - i);
    const value = Math.exp(-(x ** 2) / (2 * sigma ** 2));
    kernel.push(value);
    sum += value;
  }
  kernel = kernel.map((value) => value / sum);
  return kernel;
}

export function applyGaussianFilter(data: number[], sigma: number) {
  const kernel = createGaussianKernel(sigma);
  const center = Math.floor(kernel.length / 2);
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < kernel.length; j++) {
      let indexToRead = i - center + j;
      indexToRead = Math.max(0, indexToRead);
      indexToRead = Math.min(data.length - 1, indexToRead);
      sum += data[indexToRead] * kernel[j];
    }
    data[i] = sum;
  }
}

export async function calculateHash<T>(obj: T) {
  const textEncoder = new TextEncoder();
  const data = textEncoder.encode(JSON.stringify(obj));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

export function createPromiseThatResolvesWhen(
  condition: () => boolean,
  interval = 200,
) {
  return new Promise<void>((resolve) => {
    const checkCondition = () => {
      if (condition()) {
        resolve();
      }
      window.setTimeout(checkCondition, interval);
    };
    checkCondition();
  });
}

/**
 * タイマーです。関数を定期的に実行します。
 */
export class Timer {
  private readonly interval: number;
  private timeoutId?: number;

  get isStarted() {
    return this.timeoutId != undefined;
  }

  /**
   * @param interval 関数を実行する間隔（ミリ秒）
   */
  constructor(interval: number) {
    this.interval = interval;
  }

  start(onTick: () => void) {
    const callback = () => {
      onTick();
      this.timeoutId = window.setTimeout(callback, this.interval);
    };
    this.timeoutId = window.setTimeout(callback, this.interval);
  }

  stop() {
    if (this.timeoutId == undefined) {
      throw new Error("The timer is not started.");
    }
    window.clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }
}

/**
 * requestAnimationFrameを使用して関数を定期的に実行します。
 * 関数は、指定された最大フレームレート以下で実行されます。
 */
export class AnimationTimer {
  private readonly maxFrameTime: number;
  private readonly maxDiff: number;

  private requestId?: number;
  private prevTimeStamp?: number;
  private diff = 0;

  get isStarted() {
    return this.requestId != undefined;
  }

  /**
   * @param maxFrameRate 最大フレームレート（フレーム毎秒）
   */
  constructor(maxFrameRate = 60) {
    this.maxFrameTime = 1000 / maxFrameRate;
    this.maxDiff = this.maxFrameTime * 10;
  }

  start(onAnimationFrame: () => void) {
    if (this.requestId != undefined) {
      throw new Error("The animation frame runner is already started.");
    }

    this.diff = 0;
    this.prevTimeStamp = undefined;

    const callback = (timeStamp: number) => {
      if (this.prevTimeStamp == undefined) {
        this.diff += this.maxFrameTime;
      } else {
        this.diff += timeStamp - this.prevTimeStamp;
      }
      this.diff = Math.min(this.maxDiff, this.diff);
      if (this.diff >= this.maxFrameTime) {
        this.diff -= this.maxFrameTime;
        onAnimationFrame();
      }
      this.prevTimeStamp = timeStamp;
      this.requestId = window.requestAnimationFrame(callback);
    };
    this.requestId = window.requestAnimationFrame(callback);
  }

  stop() {
    if (this.requestId == undefined) {
      throw new Error("The animation frame runner is not started.");
    }
    window.cancelAnimationFrame(this.requestId);
    this.requestId = undefined;
  }
}
