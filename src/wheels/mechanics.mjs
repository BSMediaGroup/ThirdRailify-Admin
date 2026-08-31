export const WHEEL_MECHANICS_VERSION = 2;
export const CANONICAL_SAMPLE_COUNT = 1025;
export const CUSTOM_SHAPE_INTERPOLATION = "monotone-pchip";

const LEGACY_PRESETS = Object.freeze({
  "broadcast-smooth": Object.freeze({ holdEnd: .04, tailStart: .66, tailVelocity: .12 }),
  "heavy-flywheel": Object.freeze({ holdEnd: .1, tailStart: .74, tailVelocity: .18 }),
  "quick-draw": Object.freeze({ holdEnd: .01, tailStart: .5, tailVelocity: .05 }),
  "long-settle": Object.freeze({ holdEnd: .02, tailStart: .48, tailVelocity: .14 }),
});

export const PHYSICS_PRESETS = Object.freeze({
  "natural-hybrid": Object.freeze({
    name: "Natural Hybrid",
    description: "Exponential bearing decay with a long suspense tail and a softly engaged mechanical clicker.",
    quadraticDrag: .05, viscousDrag: .4, clickerFriction: .02, clickerOnsetSpeed: .18, clickerBlendWidth: .12, captureStartSpeed: .01, captureDurationFraction: .08,
  }),
  "heavy-flywheel": Object.freeze({
    name: "Heavy Flywheel",
    description: "Carries medium-speed momentum longer before a gradual, weighty soft stop.",
    quadraticDrag: 0, viscousDrag: .25, clickerFriction: .05, clickerOnsetSpeed: .1, clickerBlendWidth: .12, captureStartSpeed: .008, captureDurationFraction: .02,
  }),
  "suspense-tail": Object.freeze({
    name: "Suspense Tail",
    description: "Reaches the low-speed range earlier and preserves a long finite crawl.",
    quadraticDrag: .2, viscousDrag: .8, clickerFriction: .01, clickerOnsetSpeed: .3, clickerBlendWidth: .2, captureStartSpeed: .003, captureDurationFraction: .07,
  }),
  "quick-draw": Object.freeze({
    name: "Quick Draw",
    description: "Stronger early resistance with a shorter perceptual finish and no hard brake.",
    quadraticDrag: .8, viscousDrag: .2, clickerFriction: .02, clickerOnsetSpeed: .2, clickerBlendWidth: .2, captureStartSpeed: .005, captureDurationFraction: .025,
  }),
  "mechanical-clicker": Object.freeze({
    name: "Mechanical Clicker",
    description: "A more pronounced but continuously blended low-speed mechanical influence.",
    quadraticDrag: .04, viscousDrag: .34, clickerFriction: .09, clickerOnsetSpeed: .26, clickerBlendWidth: .18, captureStartSpeed: .012, captureDurationFraction: .045,
  }),
});

export const CURVE_PRESETS = Object.freeze({
  ...PHYSICS_PRESETS,
  "classic-linear": Object.freeze({ name: "Classic Linear", description: "Constant deceleration retained as a less-natural compatibility reference." }),
  "legacy-broadcast-smooth": Object.freeze({ name: "Legacy Broadcast Smooth", description: "The exact V1.12 authored hold, decay and settle-tail curve for comparison." }),
});

export const MECHANICS_BOUNDS = Object.freeze({
  quadraticDrag: Object.freeze([0, .8]),
  viscousDrag: Object.freeze([.05, 1.5]),
  clickerFriction: Object.freeze([.002, .25]),
  clickerOnsetSpeed: Object.freeze([.05, .4]),
  clickerBlendWidth: Object.freeze([.02, .25]),
  captureStartSpeed: Object.freeze([.001, .03]),
  captureDurationFraction: Object.freeze([.01, .08]),
  launchRps: Object.freeze([.5, 8]),
  minimumFullTurns: Object.freeze([2, 20]),
  maximumFullTurns: Object.freeze([2, 180]),
  spinDurationMs: Object.freeze([2000, 60000]),
  customShapePoints: Object.freeze([6, 8]),
});

export const DEFAULT_CUSTOM_SHAPE_POINTS = Object.freeze([
  Object.freeze({ time: 0, speed: 1 }),
  Object.freeze({ time: .14, speed: .76 }),
  Object.freeze({ time: .3, speed: .5 }),
  Object.freeze({ time: .5, speed: .27 }),
  Object.freeze({ time: .7, speed: .12 }),
  Object.freeze({ time: .86, speed: .045 }),
  Object.freeze({ time: 1, speed: 0 }),
]);

export const DEFAULT_WHEEL_MECHANICS = deepFreezeMechanics({
  mechanicsVersion: WHEEL_MECHANICS_VERSION,
  curveProfile: "natural-hybrid",
  physics: physicsFields(PHYSICS_PRESETS["natural-hybrid"]),
  customShape: { interpolation: CUSTOM_SHAPE_INTERPOLATION, points: DEFAULT_CUSTOM_SHAPE_POINTS.map((point) => ({ ...point })) },
  launchRpsMin: 2.8,
  launchRpsMax: 4.5,
  minimumFullTurns: 2,
  maximumFullTurns: 120,
  defaultSpinDurationMs: 6500,
  minimumSpinDurationMs: 2000,
  maximumSpinDurationMs: 60000,
});

const PROFILE_IDS = new Set([...Object.keys(CURVE_PRESETS), "custom-physics", "custom-shape"]);
const COMPILED_CACHE = new Map();
const DEFAULT_ODE_STEP = 1 / 2048;
const MAX_ODE_STEPS = 400000;

export function normalizeMechanicsConfig(value, options = {}) { return normalizeWheelMechanics(value, options); }

export function normalizeWheelMechanics(value, options = {}) {
  const strict = options.strict === true;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wheel mechanics must be an object.");
    const version = integer(value.mechanicsVersion, "Mechanics version");
    if (version === 1) return normalizeLegacyMechanics(value);
    if (version !== WHEEL_MECHANICS_VERSION) throw new Error("Choose a supported Wheel mechanics version.");
    const curveProfile = String(value.curveProfile || "");
    if (!PROFILE_IDS.has(curveProfile)) throw new Error("Choose a supported decay profile.");
    const physics = normalizePhysics(value.physics || DEFAULT_WHEEL_MECHANICS.physics);
    const customShape = normalizeCustomShape(value.customShape || DEFAULT_WHEEL_MECHANICS.customShape);
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
    return { mechanicsVersion: WHEEL_MECHANICS_VERSION, curveProfile, physics, customShape, launchRpsMin, launchRpsMax, minimumFullTurns, maximumFullTurns, defaultSpinDurationMs, minimumSpinDurationMs, maximumSpinDurationMs };
  } catch (error) {
    if (strict) throw error;
    return cloneDefaultWheelMechanics();
  }
}

export function cloneDefaultWheelMechanics() { return cloneMechanics(DEFAULT_WHEEL_MECHANICS); }

export function clickerActivation(speed, physics = DEFAULT_WHEEL_MECHANICS.physics) {
  const x = (physics.clickerOnsetSpeed + physics.clickerBlendWidth - clamp01(speed)) / physics.clickerBlendWidth;
  return smootherstep(x);
}

export function smootherstep(value) { const x = clamp01(value); return 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3; }
export function smootherstepIntegral(value) { const x = clamp01(value); return x ** 6 - 3 * x ** 5 + 2.5 * x ** 4; }

export function compileVelocityProfile(config = DEFAULT_WHEEL_MECHANICS, options = {}) {
  const mechanics = normalizeWheelMechanics(config, { strict: true });
  const sampleCount = boundedSampleCount(options.sampleCount ?? CANONICAL_SAMPLE_COUNT);
  const odeStep = boundedOdeStep(options.odeStep ?? DEFAULT_ODE_STEP);
  const source = mechanics.curveProfile === "custom-shape" ? createPchipSource(mechanics.customShape.points)
    : mechanics.curveProfile === "classic-linear" ? createClassicSource()
      : mechanics.curveProfile === "legacy-broadcast-smooth" ? createLegacySource(LEGACY_PRESETS["broadcast-smooth"])
        : createPhysicsSource(resolvePhysics(mechanics), odeStep);
  const velocity = new Float64Array(sampleCount); const deceleration = new Float64Array(sampleCount); const progress = new Float64Array(sampleCount);
  const step = 1 / (sampleCount - 1); let area = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const u = index * step; const sample = source.sample(u);
    velocity[index] = index === sampleCount - 1 ? 0 : sample.value;
    deceleration[index] = Math.max(0, -sample.derivative);
    if (index > 0) {
      const middle = (index - .5) * step;
      area += step * (velocity[index - 1] + 4 * source.sample(middle).value + velocity[index]) / 6;
      progress[index] = area;
    }
  }
  if (!Number.isFinite(area) || area <= 0) throw new Error("The compiled velocity curve has no positive angular area.");
  for (let index = 1; index < sampleCount; index += 1) progress[index] /= area;
  progress[sampleCount - 1] = 1;
  validateCompiledTables(velocity, progress);
  return { kind: "compiled-wheel-mechanics-v2", mechanics, sampleCount, velocity, deceleration, progress, area, captureStartU: source.captureStartU ?? 1, captureDerivativeScale: source.captureDerivativeScale ?? 1, physicalStopTime: source.physicalStopTime ?? null, odeStep: source.odeStep ?? null };
}

export function compileCustomShape(points, options = {}) {
  const mechanics = cloneDefaultWheelMechanics(); mechanics.curveProfile = "custom-shape";
  mechanics.customShape = normalizeCustomShape({ interpolation: CUSTOM_SHAPE_INTERPOLATION, points });
  return compileVelocityProfile(mechanics, options);
}

export function velocityAt(compiled, normalizedTime) { return lookup(compiled.velocity, clamp01(normalizedTime)); }
export function decelerationAt(compiled, normalizedTime) { return lookup(compiled.deceleration, clamp01(normalizedTime)); }
export function progressAt(compiled, normalizedTime) { const u = clamp01(normalizedTime); return u === 0 || u === 1 ? u : lookup(compiled.progress, u); }

export function rotationAt(plan, elapsedMs) {
  if (!Number.isFinite(plan.durationMs) || plan.durationMs <= 0) return plan.startRotation + plan.totalTravel;
  const compiled = plan.compiledMechanics || cachedCompile(plan.mechanics || DEFAULT_WHEEL_MECHANICS);
  return plan.startRotation + plan.totalTravel * progressAt(compiled, Number(elapsedMs) / plan.durationMs);
}

export function calculateNaturalnessDiagnostics(compiledOrConfig, options = {}) {
  const compiled = isCompiled(compiledOrConfig) ? compiledOrConfig : cachedCompile(compiledOrConfig || DEFAULT_WHEEL_MECHANICS);
  const durationMs = finitePositive(options.durationMs, 10000); const segmentCount = boundedInteger(options.segmentCount ?? 24, 2, 200, "Diagnostic segment count"); const turns = finitePositive(options.turns, 10);
  let peakDeceleration = 0; let maximumJerk = 0; let terminalPeak = 0; let precedingTailPeak = 0; const h = 1 / (compiled.sampleCount - 1);
  for (let index = 0; index < compiled.sampleCount; index += 1) {
    const u = index * h; const decel = compiled.deceleration[index]; peakDeceleration = Math.max(peakDeceleration, decel);
    if (u >= .9) terminalPeak = Math.max(terminalPeak, decel); else if (u >= .75) precedingTailPeak = Math.max(precedingTailPeak, decel);
    if (index > 0) maximumJerk = Math.max(maximumJerk, Math.abs(decel - compiled.deceleration[index - 1]) / h);
  }
  const tailStartU = firstTimeAtOrBelow(compiled.velocity, .1); const terminalAcceleration = decelerationAt(compiled, 1); const captureSpeedRemoved = velocityAt(compiled, compiled.captureStartU);
  const finalTravelPercent = (1 - progressAt(compiled, .9)) * 100;
  const handbrakeRisk = terminalPeak > Math.max(.08, precedingTailPeak * 1.5) || captureSpeedRemoved > .03 || terminalAcceleration > .02;
  const checks = { monotoneSpeed: monotoneNonIncreasing(compiled.velocity), softTerminalStop: terminalAcceleration <= .02 && velocityAt(compiled, 1) === 0, noReverseMotion: minimum(compiled.velocity) >= -1e-12, noFinalSnap: velocityAt(compiled, 1) === 0 && captureSpeedRemoved <= .03, suspenseTailPresent: 1 - tailStartU >= .18 && finalTravelPercent >= .08, frameRateIndependent: true };
  return { speedAt25: velocityAt(compiled, .25), speedAt50: velocityAt(compiled, .5), speedAt75: velocityAt(compiled, .75), speedAt90: velocityAt(compiled, .9), tailDurationFraction: 1 - tailStartU, terminalSpeed: velocityAt(compiled, 1), terminalAcceleration, peakDeceleration, maximumJerk, estimatedFinalClickIntervalMs: estimateFinalClickInterval(compiled, durationMs, turns, segmentCount), finalTravelPercent, captureSpeedRemoved, handbrakeRisk, checks };
}

export function velocityAtNormalizedTime(normalizedTime, mechanics = DEFAULT_WHEEL_MECHANICS) { return velocityAt(cachedCompile(mechanics), normalizedTime); }
export function curveTotalArea(mechanics = DEFAULT_WHEEL_MECHANICS) { return cachedCompile(mechanics).area; }
export function progressAtNormalizedTime(normalizedTime, mechanics = DEFAULT_WHEEL_MECHANICS) { return progressAt(cachedCompile(mechanics), normalizedTime); }
export function progressAtTime(elapsedMs, durationMs, mechanics = DEFAULT_WHEEL_MECHANICS) { return !Number.isFinite(durationMs) || durationMs <= 0 ? 1 : progressAtNormalizedTime(Number(elapsedMs) / durationMs, mechanics); }
export function velocityAtTime(elapsedMs, durationMs, mechanics = DEFAULT_WHEEL_MECHANICS, totalTravel = 1) { if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(totalTravel)) return 0; const compiled = cachedCompile(mechanics); return totalTravel * velocityAt(compiled, Number(elapsedMs) / durationMs) / (durationMs * compiled.area); }
export function launchRpsForSample(turnRandom, mechanics = DEFAULT_WHEEL_MECHANICS) { const safe = normalizeWheelMechanics(mechanics); const sample = finiteUnitFraction(turnRandom); return safe.launchRpsMin + (safe.launchRpsMax - safe.launchRpsMin) * sample; }

export function fullTurnsForMechanics(durationMs, turnRandom, mechanics = DEFAULT_WHEEL_MECHANICS, positiveTargetDeltaDegrees = 0) {
  const safe = normalizeWheelMechanics(mechanics); const duration = Math.min(safe.maximumSpinDurationMs, Math.max(safe.minimumSpinDurationMs, Number(durationMs) || safe.defaultSpinDurationMs));
  const targetFraction = Math.max(0, Number(positiveTargetDeltaDegrees) || 0) / 360; const idealTotalRevolutions = launchRpsForSample(turnRandom, safe) * duration / 1000 * curveTotalArea(safe);
  return Math.min(safe.maximumFullTurns, Math.max(safe.minimumFullTurns, Math.round(idealTotalRevolutions - targetFraction)));
}

export function estimatedFullTurnRange(durationMs, mechanics = DEFAULT_WHEEL_MECHANICS) {
  const safe = normalizeWheelMechanics(mechanics); const seconds = Math.max(0, Number(durationMs) || 0) / 1000; const area = curveTotalArea(safe);
  return { minimum: Math.min(safe.maximumFullTurns, Math.max(safe.minimumFullTurns, Math.round(safe.launchRpsMin * seconds * area))), maximum: Math.min(safe.maximumFullTurns, Math.max(safe.minimumFullTurns, Math.round(safe.launchRpsMax * seconds * area))) };
}

export function spinRotationAtTime(plan, elapsedMs) { return rotationAt(plan, elapsedMs); }
export function curveParameters(mechanics = DEFAULT_WHEEL_MECHANICS) { const safe = normalizeWheelMechanics(mechanics); if (safe.curveProfile === "custom-physics") return { ...safe.physics }; if (PHYSICS_PRESETS[safe.curveProfile]) return physicsFields(PHYSICS_PRESETS[safe.curveProfile]); if (safe.curveProfile === "legacy-broadcast-smooth") return { ...LEGACY_PRESETS["broadcast-smooth"] }; return {}; }

function normalizePhysics(value) {
  const physics = { quadraticDrag: boundedNumber(value.quadraticDrag, ...MECHANICS_BOUNDS.quadraticDrag, "High-speed drag"), viscousDrag: boundedNumber(value.viscousDrag, ...MECHANICS_BOUNDS.viscousDrag, "Bearing drag"), clickerFriction: boundedNumber(value.clickerFriction, ...MECHANICS_BOUNDS.clickerFriction, "Clicker resistance"), clickerOnsetSpeed: boundedNumber(value.clickerOnsetSpeed, ...MECHANICS_BOUNDS.clickerOnsetSpeed, "Clicker onset"), clickerBlendWidth: boundedNumber(value.clickerBlendWidth, ...MECHANICS_BOUNDS.clickerBlendWidth, "Clicker blend"), captureStartSpeed: boundedNumber(value.captureStartSpeed, ...MECHANICS_BOUNDS.captureStartSpeed, "Soft-stop speed"), captureDurationFraction: boundedNumber(value.captureDurationFraction, ...MECHANICS_BOUNDS.captureDurationFraction, "Soft-stop window") };
  if (physics.quadraticDrag + physics.viscousDrag + physics.clickerFriction <= 0) throw new Error("At least one drag or friction component must be non-zero.");
  if (physics.clickerOnsetSpeed + physics.clickerBlendWidth > .65) throw new Error("The clicker activation interval must remain inside the normalized speed range.");
  return physics;
}

function normalizeCustomShape(value) {
  if (!value || typeof value !== "object" || value.interpolation !== CUSTOM_SHAPE_INTERPOLATION || !Array.isArray(value.points)) throw new Error("Choose the approved monotone custom-shape interpolation.");
  const [minimum, maximum] = MECHANICS_BOUNDS.customShapePoints; if (value.points.length < minimum || value.points.length > maximum) throw new Error(`Custom shape requires ${minimum} to ${maximum} control points.`);
  const points = value.points.map((point, index) => ({ time: boundedNumber(point?.time, 0, 1, `Point ${index + 1} time`), speed: boundedNumber(point?.speed, 0, 1, `Point ${index + 1} speed`) }));
  if (points[0].time !== 0 || points[0].speed !== 1) throw new Error("The first custom-shape point is locked to time 0 and speed 1.");
  if (points.at(-1).time !== 1 || points.at(-1).speed !== 0) throw new Error("The final custom-shape point is locked to time 1 and speed 0.");
  for (let index = 1; index < points.length; index += 1) { if (points[index].time <= points[index - 1].time) throw new Error("Custom-shape point times must be strictly increasing."); if (points[index].speed > points[index - 1].speed) throw new Error("Custom-shape speed cannot rise or reverse."); }
  return { interpolation: CUSTOM_SHAPE_INTERPOLATION, points };
}

function normalizeLegacyMechanics(value) {
  const legacyProfile = String(value.curveProfile || "broadcast-smooth"); let curveProfile = legacyProfile === "broadcast-smooth" ? "legacy-broadcast-smooth" : legacyProfile === "long-settle" ? "suspense-tail" : legacyProfile;
  let customShape = { interpolation: CUSTOM_SHAPE_INTERPOLATION, points: DEFAULT_CUSTOM_SHAPE_POINTS.map((point) => ({ ...point })) };
  if (legacyProfile === "custom") { const curve = normalizeLegacyCurve(value.customCurve || LEGACY_PRESETS["broadcast-smooth"]); curveProfile = "custom-shape"; customShape = { interpolation: CUSTOM_SHAPE_INTERPOLATION, points: [0, .14, .3, .5, .7, .86, 1].map((time) => ({ time, speed: legacyVelocity(time, curve) })) }; }
  if (!PROFILE_IDS.has(curveProfile)) curveProfile = "legacy-broadcast-smooth";
  return normalizeWheelMechanics({ mechanicsVersion: WHEEL_MECHANICS_VERSION, curveProfile, physics: physicsFields(PHYSICS_PRESETS[curveProfile] || PHYSICS_PRESETS["natural-hybrid"]), customShape, launchRpsMin: value.launchRpsMin, launchRpsMax: value.launchRpsMax, minimumFullTurns: value.minimumFullTurns, maximumFullTurns: value.maximumFullTurns, defaultSpinDurationMs: value.defaultSpinDurationMs, minimumSpinDurationMs: value.minimumSpinDurationMs, maximumSpinDurationMs: value.maximumSpinDurationMs }, { strict: true });
}

function normalizeLegacyCurve(value) { const curve = { holdEnd: boundedNumber(value.holdEnd, 0, .25, "Legacy launch hold"), tailStart: boundedNumber(value.tailStart, .4, .9, "Legacy main decay end"), tailVelocity: boundedNumber(value.tailVelocity, .02, .35, "Legacy settle-tail speed") }; if (curve.tailStart < curve.holdEnd + .2) throw new Error("Legacy main decay end must remain after launch hold."); return curve; }
function resolvePhysics(mechanics) { return mechanics.curveProfile === "custom-physics" ? mechanics.physics : physicsFields(PHYSICS_PRESETS[mechanics.curveProfile] || PHYSICS_PRESETS["natural-hybrid"]); }

function createPhysicsSource(physics, odeStep) {
  const raw = integrateFrictionOde(physics, odeStep); const captureLength = physics.captureDurationFraction; const captureStartU = 1 - captureLength; const physicalScale = raw.stopTime / captureStartU;
  const friction = frictionTerms(physics.captureStartSpeed, physics); const capture = createMonotoneCapture(physics.captureStartSpeed, -friction.value * physicalScale, friction.derivative * friction.value * physicalScale ** 2, captureLength);
  return { captureStartU, captureDerivativeScale: capture.derivativeScale, physicalStopTime: raw.stopTime, odeStep, sample(u) { const x = clamp01(u); if (x >= 1) return { value: 0, derivative: 0, secondDerivative: 0 }; if (x >= captureStartU) return capture.sample((x - captureStartU) / captureLength); const value = rawAt(raw, x * physicalScale); const terms = frictionTerms(value, physics); return { value, derivative: -terms.value * physicalScale, secondDerivative: terms.derivative * terms.value * physicalScale ** 2 }; } };
}

function integrateFrictionOde(physics, step) {
  const times = [0]; const speeds = [1]; let time = 0; let speed = 1;
  for (let index = 0; index < MAX_ODE_STEPS; index += 1) {
    const previous = speed; const k1 = frictionDerivative(previous, physics); const k2 = frictionDerivative(previous + step * k1 / 2, physics); const k3 = frictionDerivative(previous + step * k2 / 2, physics); const k4 = frictionDerivative(previous + step * k3, physics);
    speed = previous + step * (k1 + 2 * k2 + 2 * k3 + k4) / 6; const nextTime = time + step;
    if (!Number.isFinite(speed)) throw new Error("The friction ODE produced a non-finite speed."); if (speed > previous + 1e-12) throw new Error("The friction ODE produced rising speed.");
    if (speed <= physics.captureStartSpeed) { const ratio = (previous - physics.captureStartSpeed) / (previous - speed); const stopTime = time + step * clamp01(ratio); times.push(stopTime); speeds.push(physics.captureStartSpeed); return { times: Float64Array.from(times), speeds: Float64Array.from(speeds), stopTime }; }
    time = nextTime; times.push(time); speeds.push(speed);
  }
  throw new Error("The friction ODE did not reach the terminal-capture speed inside the bounded integration budget.");
}

function rawAt(raw, time) { if (time <= 0) return 1; if (time >= raw.stopTime) return raw.speeds.at(-1); let low = 0; let high = raw.times.length - 1; while (high - low > 1) { const middle = (low + high) >> 1; if (raw.times[middle] <= time) low = middle; else high = middle; } const span = raw.times[high] - raw.times[low]; const fraction = span > 0 ? (time - raw.times[low]) / span : 0; return raw.speeds[low] + (raw.speeds[high] - raw.speeds[low]) * fraction; }
function frictionDerivative(speed, physics) { return -frictionTerms(Math.max(0, speed), physics).value; }
function frictionTerms(speed, physics) { const w = Math.max(0, speed); const x = clamp01((physics.clickerOnsetSpeed + physics.clickerBlendWidth - w) / physics.clickerBlendWidth); const activation = smootherstep(x); const activationDerivative = x > 0 && x < 1 ? -30 * x ** 2 * (x - 1) ** 2 / physics.clickerBlendWidth : 0; return { value: physics.quadraticDrag * w ** 2 + physics.viscousDrag * w + physics.clickerFriction * activation, derivative: 2 * physics.quadraticDrag * w + physics.viscousDrag + physics.clickerFriction * activationDerivative }; }

function createMonotoneCapture(startValue, startDerivative, startSecondDerivative, length) {
  let derivativeScale = 1; let coefficients;
  for (let attempt = 0; attempt < 18; attempt += 1) { coefficients = quinticCaptureCoefficients(startValue, startDerivative * length * derivativeScale, startSecondDerivative * length ** 2 * derivativeScale); if (captureIsMonotone(coefficients)) break; derivativeScale *= .75; }
  if (!captureIsMonotone(coefficients)) { derivativeScale = 0; coefficients = quinticCaptureCoefficients(startValue, 0, 0); }
  return { derivativeScale, sample(t) { const x = clamp01(t); if (x === 1) return { value: 0, derivative: 0, secondDerivative: 0 }; return { value: polynomial(coefficients, x), derivative: polynomialDerivative(coefficients, x) / length, secondDerivative: polynomialSecondDerivative(coefficients, x) / length ** 2 }; } };
}

function quinticCaptureCoefficients(position, velocity, acceleration) { return [position, velocity, acceleration / 2, -10 * position - 6 * velocity - 1.5 * acceleration, 15 * position + 8 * velocity + 1.5 * acceleration, -6 * position - 3 * velocity - .5 * acceleration]; }
function captureIsMonotone(coefficients) { let previous = polynomial(coefficients, 0); for (let index = 1; index <= 2048; index += 1) { const x = index / 2048; const value = polynomial(coefficients, x); if (!Number.isFinite(value) || value < -1e-12 || value > previous + 1e-12 || polynomialDerivative(coefficients, x) > 1e-10) return false; previous = value; } return true; }

function createPchipSource(points) {
  const x = points.map((point) => point.time); const y = points.map((point) => point.speed); const slopes = pchipSlopes(x, y);
  return { captureStartU: x.at(-2), sample(u) { const value = clamp01(u); if (value >= 1) return { value: 0, derivative: 0, secondDerivative: 0 }; let index = 0; while (index < x.length - 2 && value > x[index + 1]) index += 1; const h = x[index + 1] - x[index]; const t = (value - x[index]) / h; const a = y[index]; const b = slopes[index] * h; const c = 3 * (y[index + 1] - y[index]) - 2 * b - slopes[index + 1] * h; const d = 2 * (y[index] - y[index + 1]) + b + slopes[index + 1] * h; return { value: a + b * t + c * t ** 2 + d * t ** 3, derivative: (b + 2 * c * t + 3 * d * t ** 2) / h, secondDerivative: (2 * c + 6 * d * t) / h ** 2 }; } };
}

function pchipSlopes(x, y) { const count = x.length; const h = new Array(count - 1); const delta = new Array(count - 1); for (let index = 0; index < count - 1; index += 1) { h[index] = x[index + 1] - x[index]; delta[index] = (y[index + 1] - y[index]) / h[index]; } const slopes = new Array(count).fill(0); for (let index = 1; index < count - 1; index += 1) { if (delta[index - 1] === 0 || delta[index] === 0 || Math.sign(delta[index - 1]) !== Math.sign(delta[index])) slopes[index] = 0; else { const weight1 = 2 * h[index] + h[index - 1]; const weight2 = h[index] + 2 * h[index - 1]; slopes[index] = (weight1 + weight2) / (weight1 / delta[index - 1] + weight2 / delta[index]); } } slopes[0] = limitedEndpointSlope(h[0], h[1], delta[0], delta[1]); slopes[count - 1] = 0; return slopes; }
function limitedEndpointSlope(h0, h1, delta0, delta1) { let slope = ((2 * h0 + h1) * delta0 - h0 * delta1) / (h0 + h1); if (Math.sign(slope) !== Math.sign(delta0)) slope = 0; else if (Math.sign(delta0) !== Math.sign(delta1) && Math.abs(slope) > Math.abs(3 * delta0)) slope = 3 * delta0; return slope; }
function createClassicSource() { return { captureStartU: 1, sample(u) { const x = clamp01(u); return { value: 1 - x, derivative: -1, secondDerivative: 0 }; } }; }
function createLegacySource(curve) { return { captureStartU: curve.tailStart, sample(u) { const x = clamp01(u); if (x <= curve.holdEnd) return { value: 1, derivative: 0, secondDerivative: 0 }; if (x < curve.tailStart) return smootherstepSegment(x, curve.holdEnd, curve.tailStart, 1, curve.tailVelocity); return smootherstepSegment(x, curve.tailStart, 1, curve.tailVelocity, 0); } }; }
function smootherstepSegment(value, start, end, from, to) { const span = end - start; const x = clamp01((value - start) / span); return { value: from + (to - from) * smootherstep(x), derivative: (to - from) * 30 * x ** 2 * (x - 1) ** 2 / span, secondDerivative: (to - from) * 60 * x * (2 * x ** 2 - 3 * x + 1) / span ** 2 }; }
function legacyVelocity(u, curve) { if (u <= curve.holdEnd) return 1; if (u < curve.tailStart) return 1 + (curve.tailVelocity - 1) * smootherstep((u - curve.holdEnd) / (curve.tailStart - curve.holdEnd)); return curve.tailVelocity * (1 - smootherstep((u - curve.tailStart) / (1 - curve.tailStart))); }

function cachedCompile(mechanics) { if (isCompiled(mechanics)) return mechanics; const safe = normalizeWheelMechanics(mechanics); const key = JSON.stringify(safe); let compiled = COMPILED_CACHE.get(key); if (!compiled) { compiled = compileVelocityProfile(safe); if (COMPILED_CACHE.size >= 64) COMPILED_CACHE.delete(COMPILED_CACHE.keys().next().value); COMPILED_CACHE.set(key, compiled); } return compiled; }
function validateCompiledTables(velocity, progress) { if (velocity[0] !== 1 || velocity.at(-1) !== 0 || progress[0] !== 0 || progress.at(-1) !== 1) throw new Error("The compiled curve endpoints are invalid."); for (let index = 0; index < velocity.length; index += 1) { if (!Number.isFinite(velocity[index]) || velocity[index] < -1e-12 || velocity[index] > 1 + 1e-12) throw new Error("The compiled curve contains an invalid speed."); if (index > 0 && velocity[index] > velocity[index - 1] + 1e-10) throw new Error("The compiled curve contains rising speed."); if (!Number.isFinite(progress[index]) || progress[index] < -1e-12 || progress[index] > 1 + 1e-12) throw new Error("The compiled curve contains invalid progress."); if (index > 0 && progress[index] <= progress[index - 1]) throw new Error("The compiled angular progress must be strictly increasing."); } }
function estimateFinalClickInterval(compiled, durationMs, turns, segmentCount) { const crossings = Math.max(2, Math.floor(turns * segmentCount)); return (1 - inverseProgress(compiled.progress, (crossings - 1) / crossings)) * durationMs; }
function inverseProgress(table, target) { let low = 0; let high = table.length - 1; while (high - low > 1) { const middle = (low + high) >> 1; if (table[middle] < target) low = middle; else high = middle; } const span = table[high] - table[low]; return (low + (span > 0 ? (target - table[low]) / span : 0)) / (table.length - 1); }
function firstTimeAtOrBelow(table, threshold) { for (let index = 0; index < table.length; index += 1) if (table[index] <= threshold) return index / (table.length - 1); return 1; }
function lookup(table, u) { const position = u * (table.length - 1); const left = Math.floor(position); if (left >= table.length - 1) return table.at(-1); const fraction = position - left; return table[left] + (table[left + 1] - table[left]) * fraction; }
function polynomial(coefficients, x) { return (((((coefficients[5] * x + coefficients[4]) * x + coefficients[3]) * x + coefficients[2]) * x + coefficients[1]) * x + coefficients[0]); }
function polynomialDerivative(coefficients, x) { return ((((5 * coefficients[5] * x + 4 * coefficients[4]) * x + 3 * coefficients[3]) * x + 2 * coefficients[2]) * x + coefficients[1]); }
function polynomialSecondDerivative(coefficients, x) { return (((20 * coefficients[5] * x + 12 * coefficients[4]) * x + 6 * coefficients[3]) * x + 2 * coefficients[2]); }
function physicsFields(value) { return { quadraticDrag: value.quadraticDrag, viscousDrag: value.viscousDrag, clickerFriction: value.clickerFriction, clickerOnsetSpeed: value.clickerOnsetSpeed, clickerBlendWidth: value.clickerBlendWidth, captureStartSpeed: value.captureStartSpeed, captureDurationFraction: value.captureDurationFraction }; }
function cloneMechanics(value) { return { ...value, physics: { ...value.physics }, customShape: { interpolation: value.customShape.interpolation, points: value.customShape.points.map((point) => ({ ...point })) } }; }
function deepFreezeMechanics(value) { Object.freeze(value.physics); for (const point of value.customShape.points) Object.freeze(point); Object.freeze(value.customShape.points); Object.freeze(value.customShape); return Object.freeze(value); }
function isCompiled(value) { return value?.kind === "compiled-wheel-mechanics-v2" && value.velocity instanceof Float64Array; }
function monotoneNonIncreasing(values) { for (let index = 1; index < values.length; index += 1) if (values[index] > values[index - 1] + 1e-10) return false; return true; }
function minimum(values) { let result = Infinity; for (const value of values) result = Math.min(result, value); return result; }
function clamp01(value) { const number = Number(value); return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0; }
function finitePositive(value, fallback) { const result = Number(value); return Number.isFinite(result) && result > 0 ? result : fallback; }
function finiteUnitFraction(value) { const result = Number(value); if (!Number.isFinite(result) || result <= 0 || result >= 1) throw new Error("The turn variance must be strictly between zero and one."); return result; }
function integer(value, label) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer.`); return result; }
function boundedInteger(value, minimum, maximum, label) { const result = integer(value, label); if (result < minimum || result > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`); return result; }
function boundedNumber(value, minimum, maximum, label) { const result = Number(value); if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`); return result; }
function boundedSampleCount(value) { const count = boundedInteger(value, 129, 4097, "Curve sample count"); if (count % 2 === 0) throw new Error("Curve sample count must be odd."); return count; }
function boundedOdeStep(value) { const step = Number(value); if (!Number.isFinite(step) || step < 1 / 16384 || step > 1 / 128) throw new Error("ODE integration step is outside the deterministic compiler bounds."); return step; }
