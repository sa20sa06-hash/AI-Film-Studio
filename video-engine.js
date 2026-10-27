
 // AI FILM STUDIO — experimental public Gradio API bridge.
// This bridge can call a public Space only when its API is exposed and available.
// It cannot repair a failed generation inside the Space itself.
import { Client, handle_file } from "https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js";

const DEFAULT_SPACE = "techfreakworm/LTX2.3-Studio";
let client = null;
let connectedSpace = null;
let cachedEndpoints = [];

function endpointList(info) {
  const result = [];
  const named = info?.named_endpoints || {};
  for (const [name, spec] of Object.entries(named)) {
    result.push({
      name,
      title: name,
      parameters: Array.isArray(spec?.parameters) ? spec.parameters : [],
      returns: Array.isArray(spec?.returns) ? spec.returns : [],
    });
  }
  const unnamed = info?.unnamed_endpoints || {};
  if (Array.isArray(unnamed)) {
    unnamed.forEach((spec, index) => result.push({
      name: spec?.id || spec?.name || `unnamed-${index}`,
      title: spec?.name || `Unnamed endpoint ${index + 1}`,
      parameters: Array.isArray(spec?.parameters) ? spec.parameters : [],
      returns: Array.isArray(spec?.returns) ? spec.returns : [],
    }));
  } else {
    for (const [name, spec] of Object.entries(unnamed)) {
      const endpointName = name.startsWith("/") ? name : `/${name}`;
      if (!result.some(item => item.name === endpointName)) {
        result.push({
          name: endpointName,
          title: name || endpointName,
          parameters: Array.isArray(spec?.parameters) ? spec.parameters : [],
          returns: Array.isArray(spec?.returns) ? spec.returns : [],
        });
      }
    }
  }
  return result;
}

async function inspect(space = DEFAULT_SPACE) {
  if (!client || connectedSpace !== space) {
    client = await Client.connect(space, {
      events: ["data", "status"],
      status_callback: status => {
        window.dispatchEvent(new CustomEvent("studio:video-engine-status", {
          detail: {
            stage: status?.stage || "connecting",
            message: status?.message || "",
          },
        }));
      },
    });
    connectedSpace = space;
    cachedEndpoints = [];
  }

  const info = await client.view_api();
  cachedEndpoints = endpointList(info);
  if (!cachedEndpoints.length) {
    throw new Error(
      "The Space did not publish callable API endpoints. Open the Space page and check its API/Logs section."
    );
  }
  return { space, endpoints: cachedEndpoints };
}

async function toInputValue(value) {
  if (value instanceof File) return handle_file(value);
  return value;
}

function explainError(error) {
  const message = String(error?.message || error || "Unknown error");
  if (/finished without returning output data/i.test(message)) {
    return "The Space ended without returning a result. This usually means generation failed inside the external Space or it returned no output. Check the Space logs; changing this bridge alone cannot fix a server-side failure.";
  }
  if (/quota|rate.?limit|too many requests|429/i.test(message)) {
    return "The free service may have reached its quota or rate limit. Wait and try later; no paid fallback is used.";
  }
  if (/fetch|network|connect|websocket|cors/i.test(message)) {
    return "Could not reach the public Space API. Check your connection and whether the Space is awake and allows public API access.";
  }
  return message;
}

async function generate(space = DEFAULT_SPACE, endpoint, values = [], onStatus = () => {}) {
  if (!Array.isArray(values)) throw new Error("Generation inputs must be provided as a list.");
  await inspect(space);
  const selected = cachedEndpoints.find(item => item.name === endpoint);
  if (!selected) {
    throw new Error("The selected API endpoint is unavailable. Press the API inspection button again.");
  }
  if (values.length !== selected.parameters.length) {
    throw new Error(
      `This endpoint expects ${selected.parameters.length} input(s), but ${values.length} were supplied. Re-scan the API and check each field.`
    );
  }

  const payload = [];
  for (const value of values) payload.push(await toInputValue(value));

  onStatus({ stage: "submitted", message: "Request sent to the public free Space." });
  try {
    const job = client.submit(endpoint, payload);
    let finalData = null;

    for await (const message of job) {
      if (message?.type === "status") {
        const status = message.stage || message.status?.stage || "processing";
        const position = Number.isFinite(message.position) ? message.position + 1 : null;
        onStatus({
          stage: status,
          position,
          message: message.message || "",
        });
      } else if (message?.type === "data") {
        finalData = message.data;
      }
    }

    if (finalData == null) {
      throw new Error("The Space finished without returning output data.");
    }
    onStatus({ stage: "complete", message: "The Space returned output data." });
    return finalData;
  } catch (error) {
    const friendly = explainError(error);
    onStatus({ stage: "error", message: friendly });
    throw new Error(friendly);
  }
}

window.VideoEngineBridge = {
  defaultSpace: DEFAULT_SPACE,
  inspect,
  generate,
};
