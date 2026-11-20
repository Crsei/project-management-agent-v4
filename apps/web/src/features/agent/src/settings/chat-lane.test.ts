import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHAT_LANE_MIN_USABLE_WIDTH,
  CHAT_LANE_PANEL_MAX_WIDTH,
  preferredChatLaneWidth,
  resolveChatLaneWidth,
  type ChatLanePreference,
} from "./chat-lane.ts";

const widthFor = (preference: ChatLanePreference, containerWidth: number, panelOpen = false) =>
  resolveChatLaneWidth({ preference, containerWidth, panelOpen });

test("width preferences keep the documented lane widths", () => {
  assert.equal(preferredChatLaneWidth("standard"), 808);
  assert.equal(preferredChatLaneWidth("wide"), 1040);
  assert.equal(preferredChatLaneWidth("full"), null);
});

test("the lane never exceeds the conversation width", () => {
  assert.deepEqual(widthFor("standard", 1200), { width: 808, belowMinUsable: false, panelCapped: false });
  assert.deepEqual(widthFor("standard", 700), { width: 700, belowMinUsable: false, panelCapped: false });
  assert.deepEqual(widthFor("wide", 1600), { width: 1040, belowMinUsable: false, panelCapped: false });
  assert.deepEqual(widthFor("wide", 900), { width: 900, belowMinUsable: false, panelCapped: false });
  assert.equal(widthFor("full", 1600).width, 1600);
  assert.equal(widthFor("full", 900).width, 900);
});

test("an open details aside or right panel caps the lane at the reading measure", () => {
  assert.deepEqual(widthFor("standard", 1200, true), { width: 736, belowMinUsable: false, panelCapped: true });
  assert.equal(widthFor("wide", 1600, true).width, CHAT_LANE_PANEL_MAX_WIDTH);
  assert.equal(widthFor("full", 1600, true).width, CHAT_LANE_PANEL_MAX_WIDTH);
  // The cap never widens a lane that is already narrower than the measure.
  assert.equal(widthFor("standard", 700, true).width, 700);
});

test("avoidance gives up once the remaining width cannot hold a usable lane", () => {
  assert.equal(CHAT_LANE_MIN_USABLE_WIDTH, 688);
  const justBelow = widthFor("standard", CHAT_LANE_MIN_USABLE_WIDTH - 1, true);
  assert.deepEqual(justBelow, { width: 687, belowMinUsable: true, panelCapped: false });
  const atThreshold = widthFor("standard", CHAT_LANE_MIN_USABLE_WIDTH, true);
  assert.deepEqual(atThreshold, { width: 688, belowMinUsable: false, panelCapped: true });
  const squeezed = widthFor("wide", 600, true);
  assert.equal(squeezed.width, 600);
  assert.equal(squeezed.belowMinUsable, true);
});

test("invalid container measurements degrade to an empty lane instead of NaN", () => {
  assert.equal(widthFor("standard", Number.NaN).width, 0);
  assert.equal(widthFor("full", Number.POSITIVE_INFINITY).width, 0);
  assert.equal(widthFor("wide", -40).width, 0);
  assert.equal(widthFor("wide", -40).belowMinUsable, true);
});

test("resizing the conversation never snaps the lane by more than a pixel", () => {
  for (const preference of ["standard", "wide", "full"] as const) {
    for (const panelOpen of [false, true]) {
      let previous = widthFor(preference, 320, panelOpen).width;
      for (let containerWidth = 321; containerWidth <= 1600; containerWidth++) {
        const width = widthFor(preference, containerWidth, panelOpen).width;
        assert.ok(Math.abs(width - previous) <= 1, `${preference} panel=${panelOpen} at ${containerWidth}`);
        assert.ok(width <= containerWidth, `${preference} panel=${panelOpen} overflows at ${containerWidth}`);
        previous = width;
      }
    }
  }
});

test("the stylesheet mirrors the resolved lane constants", () => {
  const laneCss = readFileSync(new URL("./chat-lane.css", import.meta.url), "utf8");
  assert.match(laneCss, /--pm-chat-lane-panel-max:\s*736px/);
  assert.match(laneCss, new RegExp(`@container pm-agent-main \\(min-width: ${CHAT_LANE_MIN_USABLE_WIDTH}px\\)`));
  assert.match(laneCss, /100cqw/);
  assert.match(laneCss, /--pm-chat-lane-width:/);
  // Both side panels must trigger the avoidance lane.
  assert.match(laneCss, /\.pm-agent-thread-details\[data-presentation="inline"\]/);
  assert.match(laneCss, /\.pm-right-panel:not\(\[data-maximized="true"\]\)/);

  const chatCss = readFileSync(new URL("../../styles/pm-chat.css", import.meta.url), "utf8");
  assert.match(chatCss, /max-width: var\(--pm-chat-lane-width,/);
  const preferencesCss = readFileSync(new URL("./chat-preferences.css", import.meta.url), "utf8");
  assert.match(preferencesCss, /^@import "\.\/chat-lane\.css";/);
});
