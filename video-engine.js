// AI FILM STUDIO — safe Gradio API adapter for LTX 2.3 Studio.
// Only exposes the text-to-video generation endpoint. It deliberately refuses
// to call unrelated UI callbacks or endpoints that require media the app cannot provide.
import { Client, handle_file } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

const DEFAULT_SPACE = "techfreakworm/LTX2.3-Studio";
let client = null;
let connectedSpace = null;
let cachedEndpoints = [];

function parametersOf(spec) {
  return Array.isArray(spec?.parameters) ? spec.parameters : [];
}
function returnsOf(spec) {
  return Array.isArray(spec?.returns) ? spec.returns : [];
}
function parameterText(param) {
  const type = param?.type;
  const typeText = typeof type === "string" ? type : [type?.type, type?.name, type?.description].filter(Boolean).join(" ");
  return [param?.label, param?.parameter_name, param?.name, param?.component, param?.component_type, typeText]
    .filter(Boolean).join(" ").toLowerCase();
}
function describeMode(parameters) {
  const all = parameters.map(parameterText).join(" | ");
  if (/input.?video|source video/.test(all)) return "style-transfer";
  if (/first frame/.test(all) && /last frame/.test(all)) return "keyframe-to-video";
  if (/audio/.test(all) && /image|portrait/.test(all)) return "lipsync-or-image-audio";
  if (/audio/.test(all) && !/image|portrait/.test(all)) return "audio-to-video";
  if (/image|portrait/.test(all)) return "image-to-video";
  return "text-to-video";
}
function isTextVideoEndpoint(parameters, returns) {
  const all = parameters.map(parameterText).join(" | ");
  const hasPrompt = /\bprompt\b/.test(all);
  const hasWidth = /\bwidth\b/.test(all);
  const hasHeight = /\bheight\b/.test(all);
  const hasDuration = /\bseconds?\b|\blength\b|\bduration\b/.test(all);
  const hasFps = /\bfps\b|frames per second/.test(all);
  const hasPreset = /\bpreset\b/.test(all);
  const needsMedia = /input.?video|first frame|last frame|\bimage\b|\bportrait\b|\baudio\b/.test(all);
  // LTX 2.3's text-to-video handler has the common 8 inputs: prompt, preset,
  // width, height, length, fps, seed and randomize-seed. This discriminates it
  // from helper callbacks such as the frame-count updater.
  const outputText = returns.map(r => [r?.label, r?.type?.type, r?.python_type?.type, r?.component].filter(Boolean).join(" ")).join(" ").toLowerCase();
  return hasPrompt && hasWidth && hasHeight && hasDuration && hasFps && hasPreset && !needsMedia && parameters.length >= 8 &&
    (!outputText || /video|status|file/.test(outputText) || returns.length >= 2);
}
function endpointList(info) {
  const result = [];
  const add = (name, spec) => {
    const parameters = parametersOf(spec);
    const returns = returnsOf(spec);
    result.push({
      name,
      title: name,
      parameters,
      returns,
      mode: describeMode(parameters),
      isTextVideo: isTextVideoEndpoint(parameters, returns),
    });
  };
  for (const [name, spec] of Object.entries(info?.named_endpoints || {})) add(name, spec);
  const unnamed = info?.unnamed_endpoints || {};
  if (Array.isArray(unnamed)) {
    unnamed.forEach((spec, index) => add(spec?.id || spec?.name || `unnamed-${index}`, spec));
  } else {
    for (const [name, spec] of Object.entries(unnamed)) {
      const endpointName = name.startsWith("/") ? name : `/${name}`;
      if (!result.some(item => item.name === endpointName)) add(endpointName, spec);
    }
  }
  return result;
}

async function inspect(space = DEFAULT_SPACE) {
  if (!client || connectedSpace !== space) {
    client = await Client.connect(space, {
      status_callback: status => {
        window.dispatchEvent(new CustomEvent("studio:video-engine-status", {
          detail: { stage: status?.stage || "connecting", message: status?.message || "" },
        }));
      },
    });
    connectedSpace = space;
  }
  const info = await client.view_api();
  const allEndpoints = endpointList(info);
  cachedEndpoints = allEndpoints.filter(item => item.isTextVideo);
  if (!cachedEndpoints.length) {
    const counts = allEndpoints.map(item => `${item.name} (${item.parameters.length} inputs)`).join(", ") || "none";
    throw new Error(`The Space API did not expose a recognizable text-to-video endpoint. Found: ${counts}. Open the external Space and check its current API availability.`);
  }
  cachedEndpoints.forEach((item, index) => {
    item.title = `${index === 0 ? "Text → Video (recommended)" : "Text → Video"} — ${item.name}`;
  });
  return { space, endpoints: cachedEndpoints, ignoredEndpoints: allEndpoints.length - cachedEndpoints.length };
}

async function toInputValue(value) {
  if (value == null) return null;
  if (typeof File !== "undefined" && value instanceof File) return handle_file(value);
  return value;
}
function explainError(error) {
  const message = String(error?.message || error || "Unknown error");
  if (/finished without returning output data|without returning a result|no video result/i.test(message)) {
    return "The generation endpoint ended without returning a video. This is not a successful generation. Open the external LTX Studio to check its error/status; try the Fast preset, a shorter clip (5–6 seconds), and a small resolution. The external server may also be unavailable or out of free GPU quota.";
  }
  if (/GPU task aborted|gpu.?timeout|timeout|timed out/i.test(message)) {
    return "The free GPU run timed out. Try Fast, 5–6 seconds, and a smaller resolution. No paid fallback was used.";
  }
  if (/quota|rate.?limit|too many requests|429|daily GPU/i.test(message)) {
    return "The free service may have reached its GPU quota or rate limit. Try later or use the external Space manually; no paid fallback is used.";
  }
  if (/401|403|unauthorized|forbidden|token|sign.?in/i.test(message)) {
    return "The service may require an active Hugging Face session or may block this API request. Open the Space directly in your browser, sign in if required, and try again.";
  }
  if (/fetch|network|connect|websocket|cors|web.?socket/i.test(message)) {
    return "Could not reach the public Space API. Check the connection and whether the Space is awake and permits public API access.";
  }
  return message;
}

async function generate(space = DEFAULT_SPACE, endpoint, values = [], onStatus = () => {}) {
  if (!Array.isArray(values)) throw new Error("Generation inputs must be supplied as a list.");
  await inspect(space);
  const selected = cachedEndpoints.find(item => item.name === endpoint);
  if (!selected) throw new Error("The selected text-to-video API endpoint is unavailable. Press the API inspection button again.");
  if (!selected.isTextVideo) throw new Error("Safety check stopped the request because this endpoint is not a recognized text-to-video endpoint.");
  if (values.length !== selected.parameters.length) {
    throw new Error(`This endpoint expects ${selected.parameters.length} inputs, but ${values.length} were supplied. Re-scan the API before trying again.`);
  }
  const payload = [];
  for (const value of values) payload.push(await toInputValue(value));
  onStatus({ stage: "submitted", message: "Request sent to the public text-to-video endpoint." });
  try {
    const job = client.submit(endpoint, payload);
    let finalData = null;
    for await (const message of job) {
      if (message?.type === "status") {
        const status = message.stage || message.status?.stage || "processing";
        const position = Number.isFinite(message.position) ? message.position + 1 : null;
        onStatus({ stage: status, position, message: message.message || "" });
      } else if (message?.type === "data") {
        finalData = message.data;
      }
    }
    if (finalData == null) throw new Error("The Space finished without returning a video result.");
    onStatus({ stage: "complete", message: "The Space returned response data; checking whether it contains a video file." });
    return finalData;
  } catch (error) {
    const friendly = explainError(error);
    onStatus({ stage: "error", message: friendly });
    throw new Error(friendly);
  }
}

window.VideoEngineBridge = { defaultSpace: DEFAULT_SPACE, inspect, generate };
