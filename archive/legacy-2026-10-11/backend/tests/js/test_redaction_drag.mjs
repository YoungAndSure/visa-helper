import assert from "node:assert/strict";
import test from "node:test";
import { renderRedactionEditor } from "../../static/privacy.js";

test("drag previews a dashed box, commits on release, and cancels without masking", async (t) => {
  const nodes = [];
  const strokes = [];
  const context = {
    save() {}, restore() {}, drawImage() {}, clearRect() {}, fillRect() {},
    setLineDash(dash) { assert.ok(dash.length); },
    strokeRect(...rect) { strokes.push(rect); },
  };
  function element() {
    const node = {
      children: [], events: {}, style: { setProperty() {} },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }, setAttribute() {},
      addEventListener(name, handler) { this.events[name] = handler; },
      getContext() { return context; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
      setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {},
    };
    nodes.push(node);
    return node;
  }
  const oldDocument = globalThis.document;
  const oldBitmap = globalThis.createImageBitmap;
  t.after(() => { globalThis.document = oldDocument; globalThis.createImageBitmap = oldBitmap; });
  globalThis.document = { createElement: element };
  globalThis.createImageBitmap = async () => ({ width: 200, height: 200, close() {} });
  const material = { kind: "image", pages: [{ redactions: [] }], review_status: "ready", sanitized_file: {} };
  let changes = 0;
  await renderRedactionEditor(material, { name: "test.jpg", type: "image/jpeg" }, element(), {
    onChange: () => changes++,
  });
  const overlay = nodes.find((node) => node.events.pointerdown);
  const event = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, preventDefault() {} });
  overlay.events.pointerdown(event(80, 80));
  overlay.events.pointermove(event(20, 30));
  assert.deepEqual(strokes[0], [40, 60, 120, 100]);
  assert.equal(material.pages[0].redactions.length, 0);
  overlay.events.pointerup(event(20, 30));
  assert.equal(material.pages[0].redactions.length, 1);
  assert.equal(material.sanitized_file, null);
  assert.equal(changes, 1);
  overlay.events.pointerdown(event(10, 10));
  overlay.events.pointermove(event(200, 200));
  assert.deepEqual(strokes.at(-1), [20, 20, 180, 180]);
  overlay.events.pointercancel();
  overlay.events.pointerup(event(90, 90));
  assert.equal(material.pages[0].redactions.length, 1);
});
