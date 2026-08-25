let pc = null;
let channel = null;
let scanner = null;

const CHUNK_SIZE = 64 * 1024;
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
const MAX_FILE_NAME_LENGTH = 255;
const MAX_TOTAL_INCOMING = 2 * 1024 * 1024 * 1024; // 2 GB total in-memory limit

const $ = id => document.getElementById(id);

function show(id) {
  document.querySelectorAll("main section").forEach(x => {
    x.classList.add("hidden");
  });

  $(id).classList.remove("hidden");
}

function stripIceCandidates(sdp) {
  return sdp.split("\n")
    .filter(line => !line.startsWith("a=candidate:"))
    .join("\n");
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";

  for (let i = 0; i < 5; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }

  return result;
}

function createPeer() {
  pc = new RTCPeerConnection({
    iceServers: []
  });

  pc.onconnectionstatechange = () => {
    console.log("Connection:", pc.connectionState);

    if (pc.connectionState === "connected") {
      showConnected();
    }

    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "disconnected"
    ) {
      alert("Connection lost.");
    }
  };

  pc.ondatachannel = event => {
    setupChannel(event.channel);
  };
}

function setupChannel(dc) {
  channel = dc;

  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    showConnected();
  };

  channel.onmessage = receiveMessage;
}

/*
 * CREATE CONNECTION
 */

$("createBtn").onclick = async () => {
  show("create");

  createPeer();

  channel = pc.createDataChannel("files");

  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    showConnected();
  };

  const offer = await pc.createOffer();

  await pc.setLocalDescription(offer);

  await waitForIce();

  const desc = pc.localDescription;
  const data = JSON.stringify({
    type: desc.type,
    sdp: stripIceCandidates(desc.sdp)
  });

  $("qrcode").innerHTML = "";

  makeQR(data, $("qrcode"));

  $("shortCode").textContent = randomCode();
};

/*
 * JOIN CONNECTION
 */

$("joinBtn").onclick = async () => {
  show("join");

  scanner = new QRScanner("reader");

  await scanner.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: 250
    },
    async decodedText => {
      await scanner.pause(true);

      try {
        await joinConnection(decodedText);
        await scanner.stop();
      } catch {
        $("joinStatus").textContent = "Invalid QR code. Try again.";
        await scanner.resume();
      }
    },
    () => {}
  );
};

async function joinConnection(qrData) {
  $("joinStatus").textContent = "Connecting...";

  createPeer();

  const offer = parseJsonObject(qrData);

  if (!isValidSessionDescription(offer, "offer")) {
    throw new Error("Invalid offer");
  }

  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();

  await pc.setLocalDescription(answer);

  await waitForIce();

  const answerDesc = pc.localDescription;
  const answerData = JSON.stringify({
    type: answerDesc.type,
    sdp: stripIceCandidates(answerDesc.sdp)
  });

  show("answer");

  $("answerQr").innerHTML = "";

  makeQR(answerData, $("answerQr"));

  $("answerStatus").textContent =
    "Show this QR code to the first device.";
}

/*
 * CREATE DEVICE MUST SCAN ANSWER
 */

$("answerQr").onclick = () => {
  // Nothing needed.
};

/*
 * ICE WAITING
 */

function waitForIce() {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }

    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        resolve();
      }
    });
  });
}

/*
 * This is used by the CREATE device.
 *
 * For simplicity, the answer QR is scanned using
 * the same QR scanner.
 */

$("create").addEventListener("click", async event => {
  if (event.target.id !== "create") return;
});

/*
 * Double-click status area to scan answer.
 */

$("createStatus").onclick = async () => {
  if (!pc) return;

  $("createStatus").textContent =
    "Scan the answer QR code from the other device.";

  const reader = document.createElement("div");
  reader.id = "answerReader";

  $("create").appendChild(reader);

  const answerScanner = new QRScanner("answerReader");

  await answerScanner.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: 250
    },
    async decodedText => {
      await answerScanner.pause(true);

      try {
        const answer = parseJsonObject(decodedText);

        if (!isValidSessionDescription(answer, "answer")) {
          throw new Error("Invalid answer");
        }

        await pc.setRemoteDescription(answer);
        await answerScanner.stop();

        $("createStatus").textContent =
          "Connecting...";
      } catch {
        $("createStatus").textContent =
          "Invalid answer QR. Please scan again.";
        await answerScanner.resume();
      }
    },
    () => {}
  );
};

/*
 * FILE SENDING
 */

$("fileInput").onchange = event => {
  for (const file of event.target.files) {
    queueFile(file);
  }
};

$("dropZone").ondragover = event => {
  event.preventDefault();
};

$("dropZone").ondrop = event => {
  event.preventDefault();

  for (const file of event.dataTransfer.files) {
    queueFile(file);
  }
};

const sendQueue = [];
let sendingInProgress = false;

function queueFile(file) {
  if (!isValidOutgoingFile(file)) {
    alert(`Skipping invalid file: ${file?.name || "unknown"}`);
    return;
  }

  sendQueue.push(file);
  processSendQueue();
}

async function processSendQueue() {
  if (sendingInProgress) return;
  sendingInProgress = true;

  try {
    while (sendQueue.length > 0) {
      const file = sendQueue.shift();
      await sendFile(file);
    }
  } finally {
    sendingInProgress = false;
  }
}

async function sendFile(file) {
  if (!channel || channel.readyState !== "open") {
    alert("Not connected.");
    return;
  }

  const id = crypto.randomUUID();

  channel.send(JSON.stringify({
    type: "file-start",
    id,
    name: file.name,
    size: file.size,
    mime: file.type
  }));

  let offset = 0;

  while (offset < file.size) {

    while (channel.bufferedAmount > 4 * 1024 * 1024) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const chunk = await file.slice(
      offset,
      offset + CHUNK_SIZE
    ).arrayBuffer();

    channel.send(chunk);

    offset += chunk.byteLength;

    updateTransfer(
      id,
      file.name,
      offset,
      file.size,
      "Sending"
    );
  }

  channel.send(JSON.stringify({
    type: "file-end",
    id
  }));

  updateTransfer(
    id,
    file.name,
    file.size,
    file.size,
    "Sent"
  );
}

/*
 * FILE RECEIVING
 */

const incoming = {};
let activeIncomingId = null;

function receiveMessage(event) {

  if (typeof event.data === "string") {

    const message = parseJsonObject(event.data);
    if (!message || !isValidControlMessage(message)) return;

    if (message.type === "file-start") {
      if (activeIncomingId) return;
      if (!isValidIncomingStart(message)) return;
      if (incoming[message.id]) return;

      const totalQueued = Object.values(incoming).reduce(
        (sum, f) => sum + f.size, 0
      );
      if (totalQueued + message.size > MAX_TOTAL_INCOMING) return;

      incoming[message.id] = {
        name: message.name,
        size: message.size,
        mime: message.mime,
        chunks: [],
        received: 0
      };
      activeIncomingId = message.id;

      updateTransfer(
        message.id,
        message.name,
        0,
        message.size,
        "Receiving"
      );
    }

    if (message.type === "file-end") {
      if (!activeIncomingId || message.id !== activeIncomingId) return;

      const file = incoming[message.id];
      if (!file) return;
      if (file.received !== file.size) return;

      const blob = new Blob(file.chunks, {
        type: file.mime
      });

      const url = URL.createObjectURL(blob);

      const div = document.createElement("div");

      div.className = "transfer";

      div.innerHTML = `
        <strong>${escapeHtml(file.name)}</strong>
        <br>
        <a href="${url}" download="${escapeHtml(file.name)}">
          Download
        </a>
      `;

      $("transfers").appendChild(div);

      delete incoming[message.id];
      activeIncomingId = null;
    }

    return;
  }

  /*
   * Binary chunk
   */

  const current = activeIncomingId
    ? incoming[activeIncomingId]
    : null;

  if (!current) return;

  if (current.received + event.data.byteLength > current.size) {
    delete incoming[activeIncomingId];
    activeIncomingId = null;
    return;
  }

  current.chunks.push(event.data);
  current.received += event.data.byteLength;

  updateTransfer(
    activeIncomingId,
    current.name,
    current.received,
    current.size,
    "Receiving"
  );
}

/*
 * UI
 */

function showConnected() {
  show("connected");
  $("connectionInfo").textContent =
    "✓ Connected — files are transferred directly.";
}

function updateTransfer(id, name, current, total, status) {

  let element = document.getElementById("transfer-" + id);

  if (!element) {

    element = document.createElement("div");

    element.id = "transfer-" + id;
    element.className = "transfer";

    element.innerHTML = `
      <strong></strong>
      <progress class="progress" value="0" max="100"></progress>
      <small></small>
    `;

    $("transfers").appendChild(element);
  }

  element.querySelector("strong").textContent = name;

  element.querySelector("progress").value =
    total ? (current / total) * 100 : 0;

  element.querySelector("small").textContent =
    `${status} — ${formatBytes(current)} / ${formatBytes(total)}`;
}

function formatBytes(bytes) {

  if (bytes < 1024)
    return bytes + " B";

  if (bytes < 1024 * 1024)
    return (bytes / 1024).toFixed(1) + " KB";

  if (bytes < 1024 * 1024 * 1024)
    return (bytes / 1024 / 1024).toFixed(1) + " MB";

  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isValidSessionDescription(value, expectedType) {
  return Boolean(
    value &&
    value.type === expectedType &&
    typeof value.sdp === "string" &&
    value.sdp.length > 0 &&
    value.sdp.length < 200000
  );
}

function isValidControlMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (
    message.type !== "file-start" &&
    message.type !== "file-end"
  ) return false;
  if (!isValidTransferId(message.id)) return false;
  return true;
}

function isValidIncomingStart(message) {
  return (
    typeof message.name === "string" &&
    message.name.length > 0 &&
    message.name.length <= MAX_FILE_NAME_LENGTH &&
    Number.isInteger(message.size) &&
    message.size >= 0 &&
    message.size <= MAX_FILE_SIZE &&
    typeof message.mime === "string" &&
    message.mime.length <= 255
  );
}

function isValidOutgoingFile(file) {
  return Boolean(
    file &&
    typeof file.name === "string" &&
    file.name.length > 0 &&
    file.name.length <= MAX_FILE_NAME_LENGTH &&
    Number.isInteger(file.size) &&
    file.size >= 0 &&
    file.size <= MAX_FILE_SIZE
  );
}

function isValidTransferId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 64
  );
}

$("cancelCreate").onclick = () => location.reload();

$("cancelJoin").onclick = async () => {
  if (scanner) {
    try {
      await scanner.stop();
    } catch {}
  }

  location.reload();
};