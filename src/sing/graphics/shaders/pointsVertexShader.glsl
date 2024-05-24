#version 300 es

in vec3 pos; // 頂点の位置
in vec2 point; // ポイントの位置

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;

void main() {
  vec2 translatedPos = vec2(pos.x, pos.y) + point;
  vec3 transformedPos = projectionMatrix * translationMatrix * vec3(translatedPos, 1.0);
  gl_Position = vec4(transformedPos.xy, 0.0, 1.0);
}
