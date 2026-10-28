// AI FILM STUDIO — safe bridge for the public LTX 2.3 Studio Gradio API.
// Only exposes the verified text-to-video handler. No paid fallback is used.

import {
  Client,
  handle_file
} from "https://cdn.jsdelivr.net/npm/@gradio/client@1.15.0/dist/index.min.js";

const DEFAULT_SPACE = "techfreakworm/LTX2.3-Studio";

let client = null;
let connectedSpace = null;
let cachedEndpoints = [];
let cachedApiInfo = null;

function normalizeEndpointName(name) {
  const value = String(name || "").trim();

  if (!value) return "";

  return value.startsWith("/") ? value : `/${value}`;
}

function getParameters(spec) {
  return Array.isArray(spec?.parameters)
    ? spec.parameters
    : [];
}

function getParameterLabel(param, index) {
  return String(
    param?.label ??
    param?.parameter_name ??
    param?.name ??
    param?.component_label ??
    `Input ${index + 1}`
  ).trim();
}

function endpointList(info) {
  const result = [];
  const seen = new Set();

  const add = (name, spec, title = "") => {
    const endpointName = normalizeEndpointName(
      name || spec?.id || spec?.name
    );

    if (!endpointName || seen.has(endpointName)) return;

    seen.add(endpointName);

    result.push({
      name: endpointName,
      title: String(
        title || spec?.title || spec?.name || endpointName
      ),
      parameters: getParameters(spec),
      returns: Array.isArray(spec?.returns)
        ? spec.returns
        : []
    });
  };

  const named = info?.named_endpoints || {};

  for (const [name, spec] of Object.entries(named)) {
    add(name, spec, name);
  }

  const unnamed = info?.unnamed_endpoints || {};

  if (Array.isArray(unnamed)) {
    unnamed.forEach((spec, index) => {
      add(
        spec?.id || spec?.name || `unnamed-${index}`,
        spec,
        spec?.name || `Unnamed endpoint ${index + 1}`
      );
    });
  } else {
    for (const [name, spec] of Object.entries(unnamed)) {
      add(name, spec, name);
    }
  }

  return result;
}

function labelHas(param, pattern) {
  const text = [
    param?.label || "",
    param?.parameter_name || "",
    param?.name || "",
    param?.component || "",
    param?.component_type || ""
  ].join(" ").toLowerCase();

  return pattern.test(text);
}

function looksLikeTextToVideo(endpoint) {
  const params = endpoint.parameters;

  if (!Array.isArray(params) || params.length !== 8) {
    return false;
  }

  // Expected order in the current LTX text-to-video handler.
  const tests = [
    /prompt|description/i,
    /preset|quality/i,
    /width/i,
    /height/i,
    /seconds|duration/i,
    /fps|frame.?rate/i,
    /seed/i,
    /randomize/i
  ];

  return tests.every((pattern, index) =>
    labelHas(params[index], pattern)
  );
}

function chooseTextToVideoEndpoint(endpoints) {
  const labeledMatch = endpoints.find(looksLikeTextToVideo);

  if (labeledMatch) return labeledMatch;

  // Restricted fallback for the current Space:
  // /handler with exactly eight inputs is the text-to-video handler
  // when Gradio omits the component labels.
  // Do not select lambdas, model controls, or frame-update endpoints.
  const handler = endpoints.find(endpoint =>
    endpoint.name === "/handler" &&
    endpoint.parameters.length === 8
  );

  if (handler) return handler;

  return null;
}

function reportStatus(detail = {}) {
  try {
    window.dispatchEvent(
      new CustomEvent("studio:video-engine-status", {
        detail: {
          stage: detail.stage || "connecting",
          message: detail.message || ""
        }
      })
    );
  } catch {
    // Status reporting must not break generation.
  }
}

async function inspect(space = DEFAULT_SPACE) {
  if (!client || connectedSpace !== space) {
    reportStatus({
      stage: "connecting",
      message: `Connecting to ${space}`
    });

    client = await Client.connect(space, {
      events: ["data", "status"],

      status_callback: status => {
        reportStatus({
          stage: status?.stage || "connecting",
          message: status?.message || ""
        });
      }
    });

    connectedSpace = space;
    cachedEndpoints = [];
    cachedApiInfo = null;
  }

  // Refresh the schema so a changed Space does not leave stale endpoints.
  const info = await client.view_api();

  cachedApiInfo = info;

  const allEndpoints = endpointList(info);

  if (!allEndpoints.length) {
    throw new Error(
      "لم تنشر الخدمة نقاط API قابلة للاستدعاء. افتح صفحة Hugging Face وافحص حالة الخدمة أو سجلاتها."
    );
  }

  const textToVideo = chooseTextToVideoEndpoint(allEndpoints);

  if (!textToVideo) {
    cachedEndpoints = [];

    throw new Error(
      "لم أتمكن من التحقق بأمان من نقطة تحويل النص إلى فيديو في واجهة API الحالية. لم يتم اختيار نقطة داخلية عشوائياً. استخدم زر فتح محرك Hugging Face الخارجي، أو أعد الفحص لاحقاً إذا تغيرت واجهته."
    );
  }

  // Expose only the verified text-to-video endpoint to the UI.
  cachedEndpoints = [textToVideo];

  reportStatus({
    stage: "ready",
    message: "Verified text-to-video endpoint."
  });

  return {
    space,
    endpoints: cachedEndpoints,
    apiInfo: cachedApiInfo
  };
}

async function toInputValue(value) {
  if (
    typeof File !== "undefined" &&
    value instanceof File
  ) {
    return handle_file(value);
  }

  if (
    typeof Blob !== "undefined" &&
    value instanceof Blob
  ) {
    const name =
      typeof File !== "undefined" &&
      value instanceof File &&
      value.name
        ? value.name
        : `upload-${Date.now()}`;

    const file = new File(
      [value],
      name,
      { type: value.type || "application/octet-stream" }
    );

    return handle_file(file);
  }

  return value;
}

function parameterKey(param, index) {
  // Use Gradio's actual API input key when available.
  const key =
    param?.parameter_name ??
    param?.key ??
    `param_${index}`;

  return String(key).trim() || `param_${index}`;
}

function selectedValue(param, value, index) {
  const label = getParameterLabel(param, index).toLowerCase();

  const ratio =
    document.getElementById("videoRatio")?.value || "16:9";

  const mainPrompt =
    document.getElementById("videoPrompt")?.value?.trim() || "";

  // The verified T2V handler's inputs are ordered:
  // prompt, preset, width, height, seconds, fps, seed, randomize_seed.
  // The index fallback also works if Gradio returns generic names.
  if (index === 0 || /prompt|description/.test(label)) {
    return mainPrompt ||
      (typeof value === "string" ? value : "");
  }

  if (index === 1 || /preset|quality/.test(label)) {
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }

    const choices = Array.isArray(param?.choices)
      ? param.choices
      : Array.isArray(param?.options)
        ? param.options
        : [];

    const fast = choices.find(choice =>
      String(Array.isArray(choice) ? choice[0] : choice)
        .toLowerCase() === "fast"
    );

    return fast !== undefined
      ? (Array.isArray(fast) ? fast[0] : fast)
      : "Fast";
  }

  // Use dimensions aligned to common 32-pixel multiples.
  if (index === 2 || /width/.test(label)) {
    return ratio === "9:16"
      ? 448
      : ratio === "1:1"
        ? 512
        : 768;
  }

  if (index === 3 || /height/.test(label)) {
    return ratio === "9:16"
      ? 768
      : ratio === "1:1"
        ? 512
        : 448;
  }

  // Respect the duration selector already present in index.html.
  if (index === 4 || /seconds|duration/.test(label)) {
    const duration = Number(
      document.getElementById("videoDuration")?.value
    );

    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }

    const numeric = Number(value);

    return Number.isFinite(numeric) && numeric > 0
      ? numeric
      : 5;
  }

  if (index === 5 || /fps|frame.?rate/.test(label)) {
    const numeric = Number(value);

    return Number.isFinite(numeric) && numeric > 0
      ? numeric
      : 24;
  }

  if (
    index === 6 ||
    (/seed/.test(label) && !/randomize/.test(label))
  ) {
    const numeric = Number(value);

    return Number.isFinite(numeric) && numeric >= 0
      ? Math.trunc(numeric)
      : 42;
  }

  if (index === 7 || /randomize/.test(label)) {
    if (value === true || value === 1) return true;

    return [
      "true",
      "1",
      "yes",
      "on"
    ].includes(String(value ?? "").trim().toLowerCase());
  }

  if (value !== null && value !== undefined && value !== "") {
    const type = String(
      param?.parameter_type ||
      param?.type?.type ||
      param?.type ||
      ""
    ).toLowerCase();

    if (
      /number|integer|float|slider/.test(type) &&
      typeof value === "string"
    ) {
      const number = Number(value);

      return Number.isFinite(number) ? number : value;
    }

    return value;
  }

  return null;
}

function buildPayload(endpoint, values) {
  if (!Array.isArray(values)) {
    throw new Error(
      "تعذر قراءة مدخلات التوليد. أعد فحص API ثم حاول مرة أخرى."
    );
  }

  if (values.length !== endpoint.parameters.length) {
    throw new Error(
      `نقطة التوليد تتوقع ${endpoint.parameters.length} مدخلات، لكن الواجهة أرسلت ${values.length}. أعد فحص API.`
    );
  }

  const payload = {};

  endpoint.parameters.forEach((param, index) => {
    const key = parameterKey(param, index);

    payload[key] = selectedValue(
      param,
      values[index],
      index
    );
  });

  return payload;
}

function explainError(error) {
  const raw = String(error?.message || error || "Unknown error");
  const message = raw.replace(/\s+/g, " ").trim();

  if (
    /finished without returning output data|without returning output/i
      .test(message)
  ) {
    return "انتهت الخدمة دون إرجاع فيديو. غالباً فشل التوليد داخل Space أو لم ينتج ملفاً؛ افحص سجل الخدمة أو جرّبها من واجهتها الأصلية. تعديل الموقع وحده لا يصلح عطل النموذج الخادمي.";
  }

  if (
    /quota|rate.?limit|too many requests|\b429\b|gpu limit|daily limit/i
      .test(message)
  ) {
    return "قد تكون حصة الخدمة المجانية أو حد GPU قد نفد. لا توجد خدمة مدفوعة بديلة داخل التطبيق؛ جرّب لاحقاً أو استخدم واجهة Hugging Face الأصلية.";
  }

  if (
    /fetch|network|connect|websocket|cors|failed to fetch|timeout/i
      .test(message)
  ) {
    return "تعذر الوصول إلى API العام. تحقق من الإنترنت ومن أن Space تعمل وتقبل الطلبات العامة، ثم أعد الفحص.";
  }

  if (
    /401|403|unauthorized|forbidden|not logged/i.test(message)
  ) {
    return "رفضت الخدمة الطلب أو تتطلب جلسة لا يوفّرها الربط العام. افتح واجهة Hugging Face الأصلية وجرب التوليد منها.";
  }

  return message;
}

async function generate(
  space = DEFAULT_SPACE,
  endpointName,
  values = [],
  onStatus = () => {}
) {
  if (typeof onStatus !== "function") {
    onStatus = () => {};
  }

  const promptText = String(
    document.getElementById("videoPrompt")?.value || ""
  ).trim();

  if (!promptText) {
    throw new Error("اكتب وصف الفيديو أولاً.");
  }

  const inspected = await inspect(space);

  const selected = inspected.endpoints.find(
    item => item.name === normalizeEndpointName(endpointName)
  );

  if (!selected) {
    throw new Error(
      "نقطة التوليد المحددة غير متاحة أو ليست نقطة النص إلى فيديو الموثقة. اضغط فحص API مرة أخرى."
    );
  }

  const payload = buildPayload(selected, values);

  for (const [key, value] of Object.entries(payload)) {
    payload[key] = await toInputValue(value);
  }

  onStatus({
    stage: "submitted",
    message: "أُرسل طلب النص إلى الفيديو إلى الخدمة المجانية."
  });

  reportStatus({
    stage: "submitted",
    message: "T2V request submitted."
  });

  try {
    // Important: Gradio submit expects an object payload, not an array.
    const job = client.submit(selected.name, payload);

    let finalData = null;

    for await (const message of job) {
      if (message?.type === "status") {
        const detail = message.status || message;

        const stage =
          message.stage ||
          detail?.stage ||
          "processing";

        const position = Number.isFinite(message.position)
          ? message.position + 1
          : null;

        const text =
          message.message ||
          detail?.message ||
          "";

        onStatus({
          stage,
          position,
          message: text
        });

        reportStatus({
          stage,
          message: text
        });
      } else if (message?.type === "data") {
        finalData = message.data;

        onStatus({
          stage: "receiving",
          message: "وصلت استجابة من الخدمة؛ جارٍ تجهيز النتيجة."
        });
      }
    }

    if (finalData === null || finalData === undefined) {
      throw new Error(
        "The Space finished without returning output data."
      );
    }

    onStatus({
      stage: "complete",
      message: "أعادت الخدمة نتيجة. تحقق من ملف الفيديو أدناه."
    });

    reportStatus({
      stage: "complete",
      message: "The Space returned output data."
    });

    return finalData;
  } catch (error) {
    const friendly = explainError(error);

    onStatus({
      stage: "error",
      message: friendly
    });

    reportStatus({
      stage: "error",
      message: friendly
    });

    throw new Error(friendly);
  }
}

window.VideoEngineBridge = {
  defaultSpace: DEFAULT_SPACE,
  inspect,
  generate
};
