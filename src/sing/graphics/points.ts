import * as PIXI from "pixi.js";
import lineStripVertexShaderSource from "@/sing/graphics/shaders/pointsVertexShader.glsl?raw";
import fragmentShaderSource from "@/sing/graphics/shaders/fragmentShader.glsl?raw";
import { Color } from "@/sing/graphics/color";

/**
 * 複数のポイントを描画します。
 */
export class Points {
  readonly color: Color;
  readonly radius: number;
  private readonly mesh: PIXI.Mesh<PIXI.Shader>;
  private readonly shader: PIXI.Shader;
  private readonly geometry: PIXI.Geometry;
  private readonly pointsBuffer: PIXI.Buffer;

  private points: Float32Array;

  get displayObject() {
    return this.mesh as PIXI.DisplayObject;
  }

  get renderable() {
    return this.mesh.renderable;
  }
  set renderable(value: boolean) {
    this.mesh.renderable = value;
  }

  get numOfPoints() {
    return this.points.length / 2;
  }
  set numOfPoints(value: number) {
    if (value < 1) {
      throw new Error("The number of points must be at least 1.");
    }
    this.points = new Float32Array(value * 2);
  }

  /**
   * @param numOfPoints ポイントの数
   * @param color ポイントの色（RGBA）
   * @param radius ポイントの半径（px）
   */
  constructor(
    numOfPoints: number,
    color: Color,
    radius: number,
    resolution: number,
  ) {
    if (numOfPoints < 1) {
      throw new Error("The number of points must be at least 1.");
    }
    this.color = color;
    this.radius = radius;
    this.shader = PIXI.Shader.from(
      lineStripVertexShaderSource,
      fragmentShaderSource,
      { color: color.toRgbaArray().map((value) => value / 255) },
    );
    this.points = new Float32Array(numOfPoints * 2);
    this.pointsBuffer = new PIXI.Buffer(this.points, false);
    const vertices = this.generatePointVertices(radius, resolution);
    const sizeOfFloat = 4;
    this.geometry = new PIXI.Geometry();
    this.geometry.instanced = true;
    this.geometry.instanceCount = numOfPoints;
    this.geometry.addAttribute("pos", vertices.flat(), 3);
    this.geometry.addAttribute(
      "point",
      this.pointsBuffer,
      2,
      false,
      PIXI.TYPES.FLOAT,
      sizeOfFloat * 2,
      0,
      true,
    );
    this.mesh = new PIXI.Mesh(this.geometry, this.shader);
  }

  private generatePointVertices(radius: number, resolution: number) {
    const vertices: [number, number, number][] = [];
    for (let i = 0; i < resolution; i++) {
      const theta0 = (2 * Math.PI * i) / resolution;
      const theta1 = (2 * Math.PI * (i + 1)) / resolution;
      vertices.push([0, 0, 0]);
      vertices.push([Math.cos(theta0) * radius, Math.sin(theta0) * radius, 0]);
      vertices.push([Math.cos(theta1) * radius, Math.sin(theta1) * radius, 0]);
    }
    return vertices;
  }

  /**
   * ポイントを設定します。設定し終わったら`update()`を呼んでください。
   */
  setPoint(index: number, x: number, y: number) {
    this.points[2 * index] = x;
    this.points[2 * index + 1] = y;
  }

  /**
   * Pointsを更新します。（設定されたポイントを適用します）
   */
  update() {
    this.pointsBuffer.update(this.points);
    if (this.geometry.instanceCount !== this.numOfPoints) {
      this.geometry.instanceCount = this.numOfPoints;
    }
  }

  /**
   * 破棄します。
   */
  destroy() {
    this.mesh.destroy();
    this.geometry.destroy();
    this.shader.destroy();
    this.pointsBuffer.destroy();
  }
}
