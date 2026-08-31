export const WHEEL_MECHANICS_VERSION = 1;

export const CURVE_PRESETS = Object.freeze({
  "broadcast-smooth": Object.freeze({ name: "Broadcast Smooth", description: "Fast launch, rounded decay and a long controlled finish.", holdEnd: .04, tailStart: .66, tailVelocity: .12 }),
  "heavy-flywheel": Object.freeze({ name: "Heavy Flywheel", description: "Sustained momentum with a later, heavier settling phase.", holdEnd: .1, tailStart: .74, tailVelocity: .18 }),
  "quick-draw": Object.freeze({ name: "Quick Draw", description: "Immediate early decay and a short, quiet finish.", holdEnd: .01, tailStart: .5, tailVelocity: .05 }),
  "long-settle": Object.freeze({ name: "Long Settle", description: "Early main decay followed by an extended low-speed tail.", holdEnd: .02, tailStart: .48, tailVelocity: .14 }),
  "classic-linear": Object.freeze({ name: "Classic Linear", description: "The original constant-deceleration velocity profile.", holdEnd: 0, tailStart: 1, tailVelocity: 0 }),
});

export const MECHANICS_BOUNDS = Object.freeze({
  holdEnd: Object.freeze([0, .25]),
  tailStart: Object.freeze([.4, .9]),
  tailVelocity: Object.freeze([.02, .35]),
  launchRps: Object.freeze([.5, 8]),
  minimumFullTurns: Object.freeze([2, 20]),
  maximumFullTurns: Object.freeze([2, 180]),
  spinDurationMs: Object.freeze([2000, 60000]),
});

export const DEFAULT_WHEEL_MECHANICS = Object.freeze({
  mechanicsVersion: WHEEL_MECHANICS_VERSION,
  curveProfile: "broadcast-smooth",
  customCurve: Object.freeze({ holdEnd: .04, tailStart: .66, tailVelocity: .12 }),
  launchRpsMin: 2.8,
  launchRpsMax: 4.5,
  minimumFullTurns: 2,
  maximumFullTurns: 120,
  defaultSpinDurationMs: 6500,
  minimumSpinDurationMs: 2000,
  maximumSpinDurationMs: 60000,
});

const PROFILES = new Set([...Object.keys(CURVE_PRESETS), "custom"]);

export function normalizeWheelMechanics(value, options = {}) {
  const strict = options.strict === true;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wheel mechanics must be an object.");
    const mechanicsVersion = integer(value.mechanicsVersion, "Mechanics version");
    if (mechanicsVersion !== WHEEL_MECHANICS_VERSION) throw new Error("Choose a supported Wheel mechanics version.");
    const curveProfile = String(value.curveProfile || "");
    if (!PROFILES.has(curveProfile)) throw new Error("Choose a supported decay profile.");
    const customInput = value.customCurve && typeof value.customCurve === "object" ? value.customCurve : DEFAULT_WHEEL_MECHANICS.customCurve;
    const customCurve = {
      holdEnd: boundedNumber(customInput.holdEnd, ...MECHANICS_BOUNDS.holdEnd, "Launch hold"),
      tailStart: boundedNumber(customInput.tailStart, ...MECHANICS_BOUNDS.tailStart, "Main decay end"),
      tailVelocity: boundedNumber(customInput.tailVelocity, ...MECHANICS_BOUNDS.tailVelocity, "Settle-tail speed"),
    };
    if (customCurve.tailStart < customCurve.holdEnd + .2) throw new Error("Main decay end must be at least 20 percentage points after launch hold.");
    const launchRpsMin = boundedNumber(value.launchRpsMin, ...MECHANICS_BOUNDS.launchRps, "Minimum launch speed");
    const launchRpsMax = boundedNumber(value.launchRpsMax, ...MECHANICS_BOUNDS.launchRps, "Maximum launch speed");
    if (launchRpsMax < launchRpsMin) throw new Error("Maximum launch speed must be at least the minimum launch speed.");
    const minimumFullTurns = boundedInteger(value.minimumFullTurns, ...MECHANICS_BOUNDS.minimumFullTurns, "Minimum full turns");
    const maximumFullTurns = boundedInteger(value.maximumFullTurns, ...MECHANICS_BOUNDS.maximumFullTurns, "Maximum full turns");
    if (maximumFullTurns < minimumFullTurns) throw new Error("Maximum full turns must be at least the minimum full turns.");
    const minimumSpinDurationMs = boundedInteger(value.minimumSpinDurationMs, ...MECHANICS_BOUNDS.spinDurationMs, "Minimum spin duration");
    const maximumSpinDurationMs = boundedInteger(value.maximumSpinDurationMs, ...MECHANICS_BOUNDS.spinDurationMs, "Maximum spin duration");
    const defaultSpinDurationMs = boundedInteger(value.defaultSpinDurationMs, ...MECHANICS_BOUNDS.spinDurationMs, "Default spin duration");
    if (minimumSpinDurationMs > maximumSpinDurationMs) throw new Error("Maximum spin duration must be at least the minimum spin duration.");
    if (defaultSpinDurationMs < minimumSpinDurationMs || defaultSpinDurationMs > maximumSpinDurationMs) throw new Error("Default spin duration must sit inside the allowed duration range.");
    return { mechanicsVersion, curveProfile, customCurve, launchRpsMin, launchRpsMax, minimumFullTurns, maximumFullTurns, defaultSpinDurationMs, minimumSpinDurationMs, maximumSpinDurationMs };
  } catch (error) {
    if (strict) throw error;
    return cloneDefaultWheelMechanics();
  }
}

export function cloneDefaultWheelMechanics() {
  return { ...DEFAULT_WHEEL_MECHANICS, customCurve: { ...DEFAULT_WHEEL_MECHANICS.customCurve } };
}

export function curveParameters(mechanics) {
  const safe = normalizeWheelMechanics(mechanics);
  if (safe.curveProfile === "custom") return { ...safe.customCurve };
  return { ...CURVE_PRESETS[safe.curveProfile] };
}

export function smootherstep(value) {
  const x = clamp01(value);
  return 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
}

export function smootherstepIntegral(value) {
  const x = clamp01(value);
  return x ** 6 - 3 * x ** 5 + 2.5 * x ** 4;
}

export function velocityAtNormalizedTime(normalizedTime, mechanics = DEFAULT_WHEEL_MECHANICS) {
  const u = clamp01(normalizedTime); const safe = normalizeWheelMechanics(mechanics);
  if (safe.curveProfile === "classic-linear") return 1 - u;
  const { holdEnd: h, tailStart: q, tailVelocity: r } = curveParameters(safe);
  if (u <= h) return 1;
  if (u < q) return 1 + (r - 1) * smootherstep((u - h) / (q - h));
  return r * (1 - smootherstep((u - q) / (1 - q)));
}

export function curveTotalArea(mechanics = DEFAULT_WHEEL_MECHANICS) {
  const safe = normalizeWheelMechanics(mechanics);
  if (safe.curveProfile === "classic-linear") return .5;
  const { holdEnd: h, tailStart: q, tailVelocity: r } = curveParameters(safe);
  return h + (q - h) * (1 + r) / 2 + (1 - q) * r / 2;
}

export function progressAtNormalizedTime(normalizedTime, mechanics = DEFAULT_WHEEL_MECHANICS) {
  const u = clamp01(normalizedTime); const safe = normalizeWheelMechanics(mechanics);
  if (u === 0 || u === 1) return u;
  if (safe.curveProfile === "classic-linear") return 2 * u - u ** 2;
  const { holdEnd: h, tailStart: q, tailVelocity: r } = curveParameters(safe); const total = curveTotalArea(safe);
  if (u <= h) return u / total;
  const area1 = h;
  if (u < q) {
    const x = (u - h) / (q - h);
    return (area1 + (u - h) + (r - 1) * (q - h) * smootherstepIntegral(x)) / total;
  }
  const area2 = (q - h) * (1 + r) / 2; const x = (u - q) / (1 - q);
  return (area1 + area2 + r * (u - q) - r * (1 - q) * smootherstepIntegral(x)) / total;
}

export function progressAtTime(elapsedMs, durationMs, mechanics = DEFAULT_WHEEL_MECHANICS) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return progressAtNormalizedTime(Number(elapsedMs) / durationMs, mechanics);
}

export function velocityAtTime(elapsedMs, durationMs, mechanics = DEFAULT_WHEEL_MECHANICS, totalTravel = 1) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(totalTravel)) return 0;
  return totalTravel * velocityAtNormalizedTime(Number(elapsedMs) / durationMs, mechanics) / (durationMs * curveTotalArea(mechanics));
}

export function launchRpsForSample(turnRandom, mechanics = DEFAULT_WHEEL_MECHANICS) {
  const safe = normalizeWheelMechanics(mechanics); const sample = finiteUnitFraction(turnRandom);
  return safe.launchRpsMin + (safe.launchRpsMax - safe.launchRpsMin) * sample;
}

export function fullTurnsForMechanics(durationMs, turnRandom, mechanics = DEFAULT_WHEEL_MECHANICS, positiveTargetDeltaDegrees = 0) {
  const safe = normalizeWheelMechanics(mechanics); const duration = Math.min(safe.maximumSpinDurationMs, Math.max(safe.minimumSpinDurationMs, Number(durationMs) || safe.defaultSpinDurationMs));
  const targetFraction = Math.max(0, Number(positiveTargetDeltaDegrees) || 0) / 360;
  const idealTotalRevolutions = launchRpsForSample(turnRandom, safe) * duration / 1000 * curveTotalArea(safe);
  return Math.min(safe.maximumFullTurns, Math.max(safe.minimumFullTurns, Math.round(idealTotalRevolutions - targetFraction)));
}

export function estimatedFullTurnRange(durationMs, mechanics = DEFAULT_WHEEL_MECHANICS) {
  const safe = normalizeWheelMechanics(mechanics); const seconds = Math.max(0, Number(durationMs) || 0) / 1000; const area = curveTotalArea(safe);
  return {
    minimum: Math.min(safe.maximumFullTurns, Math.max(safe.minimumFullTurns, Math.round(safe.launchRpsMin * seconds * area))),
    maximum: Math.min(safe.maximumFullTurns, Math.max(safe.minimumFullTurns, Math.round(safe.launchRpsMax * seconds * area))),
  };
}

export function spinRotationAtTime(plan, elapsedMs) {
  return plan.startRotation + plan.totalTravel * progressAtTime(elapsedMs, plan.durationMs, plan.mechanics);
}

function clamp01(value) { return Math.min(1, Math.max(0, Number(value) || 0)); }
function finiteUnitFraction(value) { const result = Number(value); if (!Number.isFinite(result) || result <= 0 || result >= 1) throw new Error("The turn variance must be strictly between zero and one."); return result; }
function integer(value, label) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer.`); return result; }
function boundedInteger(value, minimum, maximum, label) { const result = integer(value, label); if (result < minimum || result > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`); return result; }
function boundedNumber(value, minimum, maximum, label) { const result = Number(value); if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`); return result; }
