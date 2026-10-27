// Optional direct Gradio API adapter. If this CDN or public Space is unavailable,
// the main application keeps working and the external manual link remains available.
import { Client, handle_file } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

const DEFAULT_SPACE = "techfreakworm/LTX2.3-Studio";
let client = null;
let connectedSpace = null;

function endpointList(info) {
  const result = [];
  const named = info?.named_endpoints || {};
  for (const [name, spec] of Object.entries(named)) {
    result.push({ name, title: spec?.parameters?.length ? name : `${name} (no inputs)`, parameters: Array.isArray(spec?.parameters) ? spec.parameters : [], returns: spec?.returns || [] });
  }
  const unnamed = info?.unnamed_endpoints || {};
  if (Array.isArray(unnamed)) {
    unnamed.forEach((spec, index) => result.push({ name: spec?.id || spec?.name || `unnamed-${index}`, title: spec?.name || `Unnamed endpoint ${index+1}`, parameters: spec?.parameters || [], returns: spec?.returns || [] }));
  } else {
    for (const [name, spec] of Object.entries(unnamed)) {
      result.push({ name: name.startsWith("/") ? name : `/${name}`, title: name || "Unnamed endpoint", parameters: Array.isArray(spec?.parameters) ? spec.parameters : [], returns: spec?.returns || [] });
    }
  }
  return result;
}

async function inspect(space = DEFAULT_SPACE) {
  if (!client || connectedSpace !== space) {
    client = await Client.connect(space, {
      events: ["data", "status"],
      status_callback: (status) => {
        window.dispatchEvent(new CustomEvent("studio:video-engine-status", { detail: { stage: status?.stage || "connecting", message: status?.message || "" } }));
      },
    });
    connectedSpace = space;
  }
  const info = await client.view_api();
  const endpoints = endpointList(info);
  if (!endpoints.length) throw new Error("The public Space did not expose any callable API endpoints.");
  return { space, endpoints };
}

async function toInputValue(value, component) {
  if (value instanceof File) return handle_file(value);
  return value;
}

async function generate(space, endpoint, values, onStatus = () => {}) {
  const { endpoints } = await inspect(space);
  const selected = endpoints.find(item => item.name === endpoint);
  if (!selected) throw new Error("The selected API endpoint is no longer available. Re-scan the API.");
  const payload = [];
  for (let i = 0; i < values.length; i++) payload.push(await toInputValue(values[i], selected.parameters[i]?.component));
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
  if (finalData == null) throw new Error("The Space finished without returning output data.");
  return finalData;
}

window.VideoEngineBridge = {
  defaultSpace: DEFAULT_SPACE,
  inspect,
  generate,
};
