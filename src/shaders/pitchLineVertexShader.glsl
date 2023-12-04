precision mediump float;
attribute vec3 pos;
attribute vec2 p1, p2;

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;

void main() {
  vec2 basisVecX = normalize(p2 - p1);
  vec2 basisVecY = vec2(-basisVecX.y, basisVecX.x);
  vec2 p3 = p1 + basisVecX * pos.x + basisVecY * pos.y;
  vec2 p4 = p2 + basisVecX * pos.x + basisVecY * pos.y;
  vec3 p5 = vec3(mix(p3, p4, pos.z), 1.0);
  gl_Position = vec4((projectionMatrix * translationMatrix * p5).xy, 0.0, 1.0);
}
