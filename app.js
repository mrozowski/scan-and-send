let pc = null;
let channel = null;
let scanner = null;

const CHUNK_SIZE = 64 * 1024;

const $ = id => document.getElementById(id);

function show(id) {
  document.querySelectorAll("main section").forEach(x => {
    x.classList.add("hidden");
  });

  $(id).classList.remove("hidden");
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

  const data = JSON.stringify(pc.localDescription);

  $("qrcode").innerHTML = "";

  new QRCode($("qrcode"), {
    text: data,
    width: 280,
    height: 280
  });

  $("shortCode").textContent = randomCode();
};

/*
 * JOIN CONNECTION
 */

$("joinBtn").onclick = async () => {
  show("join");

  scanner = new Html5Qrcode("reader");

  scanner.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: 250
    },
    async decodedText => {
      await scanner.stop();

      await joinConnection(decodedText);
    },
    () => {}
  );
};

async function joinConnection(qrData) {
  $("joinStatus").textContent = "Connecting...";

  createPeer();

  const offer = JSON.parse(qrData);

  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();

  await pc.setLocalDescription(answer);

  await waitForIce();

  const answerData = JSON.stringify(pc.localDescription);

  show("answer");

  $("answerQr").innerHTML = "";

  new QRCode($("answerQr"), {
    text: answerData,
    width: 280,
    height: 280
  });

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

  const answerScanner = new Html5Qrcode("answerReader");

  await answerScanner.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: 250
    },
    async decodedText => {
      await answerScanner.stop();

      const answer = JSON.parse(decodedText);

      await pc.setRemoteDescription(answer);

      $("createStatus").textContent =
        "Connecting...";
    },
    () => {}
  );
};

/*
 * FILE SENDING
 */

$("fileInput").onchange = event => {
  for (const file of event.target.files) {
    sendFile(file);
  }
};

$("dropZone").ondragover = event => {
  event.preventDefault();
};

$("dropZone").ondrop = event => {
  event.preventDefault();

  for (const file of event.dataTransfer.files) {
    sendFile(file);
  }
};

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

function receiveMessage(event) {

  if (typeof event.data === "string") {

    const message = JSON.parse(event.data);

    if (message.type === "file-start") {

      incoming[message.id] = {
        name: message.name,
        size: message.size,
        mime: message.mime,
        chunks: [],
        received: 0
      };

      updateTransfer(
        message.id,
        message.name,
        0,
        message.size,
        "Receiving"
      );
    }

    if (message.type === "file-end") {

      const file = incoming[message.id];

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
    }

    return;
  }

  /*
   * Binary chunk
   */

  const current = Object.values(incoming)[0];

  if (!current) return;

  current.chunks.push(event.data);
  current.received += event.data.byteLength;

  updateTransfer(
    Object.keys(incoming)[0],
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
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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