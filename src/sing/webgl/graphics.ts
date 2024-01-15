import * as PIXI from "pixi.js";
import lineStripVertexShaderSource from "@/sing/webgl/shaders/lineStripVertexShader.glsl?raw";
import fragmentShaderSource from "@/sing/webgl/shaders/fragmentShader.glsl?raw";

export class LineStrip {
  readonly mesh: PIXI.Mesh<PIXI.Shader>;
  readonly points: Float32Array;
  private readonly buffer: PIXI.Buffer;

  constructor(numOfPoints: number, color: number[], width: number) {
    if (numOfPoints < 2) {
      throw new Error("The number of points must be at least 2.");
    }
    const shader = PIXI.Shader.from(
      lineStripVertexShaderSource,
      fragmentShaderSource,
      { color }
    );
    const points = new Float32Array(numOfPoints * 2);
    const buffer = new PIXI.Buffer(points, false);
    const vertices = this.generateSegmentVertices(width);
    const geometry = new PIXI.Geometry();
    geometry.instanced = true;
    geometry.instanceCount = numOfPoints - 1;
    geometry.addAttribute("pos", vertices.flat(), 3);
    geometry.addAttribute(
      "p1",
      buffer,
      2,
      false,
      PIXI.TYPES.FLOAT,
      4 * 2,
      0,
      true
    );
    geometry.addAttribute(
      "p2",
      buffer,
      2,
      false,
      PIXI.TYPES.FLOAT,
      4 * 2,
      4 * 2,
      true
    );
    this.points = points;
    this.buffer = buffer;
    this.mesh = new PIXI.Mesh(geometry, shader);
  }

  private generateSegmentVertices(width: number) {
    const halfWidth = width / 2;
    return [
      [-halfWidth, -halfWidth, 0],
      [halfWidth, -halfWidth, 1],
      [halfWidth, -halfWidth + width, 1],
      [-halfWidth, -halfWidth, 0],
      [halfWidth, -halfWidth + width, 1],
      [-halfWidth, -halfWidth + width, 0],
    ];
  }

  update() {
    this.buffer.update(this.points);
  }
}
