const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
const wrapper = document.getElementById('canvas-wrapper');
const socket = io();

// ── State ─────────────────────────────────────────────────────────────
let myUserName = '', currentTool = 'pen', currentSize = 5, drawing = false;
let startX, startY, snapshot, lastX = 0, lastY = 0;

// Shape object store  {type,x1,y1,x2,y2,color,size,fill,text,fontSize}
let shapeObjects = [];
let penLayerData = null;   // ImageData of raster pen/eraser strokes
let undoStack = [], redoStack = [];

// Selection state
let selectedIdx = -1;
let isResizingHandle = false;
let isDraggingBody = false;
let activeHandle = -1;
let dragStart = { x: 0, y: 0 };
let origShape = null;

const SHAPE_TOOLS = ['rect', 'circle', 'triangle', 'diamond', 'star', 'line-shape', 'dotted-line'];

// ── Canvas resize ──────────────────────────────────────────────────────
function resizeCanvas() {
    const data = canvas.toDataURL();
    canvas.width = wrapper.clientWidth;
    canvas.height = wrapper.clientHeight;
    const bg = document.body.classList.contains('dark-mode') ? '#1e1e28' : 'white';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new Image(); img.src = data;
    img.onload = () => { ctx.drawImage(img, 0, 0); penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height); redrawShapes(); };
}
window.addEventListener('resize', () => { resizeCanvas(); updateSelOverlay(); });
resizeCanvas();

// ── Coord helpers ──────────────────────────────────────────────────────
function toCanvas(ex, ey) {
    const r = canvas.getBoundingClientRect();
    return { x: (ex - r.left) * canvas.width / r.width, y: (ey - r.top) * canvas.height / r.height };
}
function toScreen(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return { x: r.left + cx * r.width / canvas.width, y: r.top + cy * r.height / canvas.height };
}

// ── Redraw ────────────────────────────────────────────────────────────
function redrawAll() {
    if (penLayerData) ctx.putImageData(penLayerData, 0, 0);
    else { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    redrawShapes();
}
function redrawShapes() { shapeObjects.forEach(s => renderShapeObj(s)); }
function renderShapeObj(s) {
    if (s.type === 'text') {
        ctx.fillStyle = s.color; ctx.font = `${s.fontSize}px Arial`;
        ctx.fillText(s.text, s.x1, s.y1 + s.fontSize);
    } else {
        drawShape(s.type, s.x1, s.y1, s.x2, s.y2, s.color, s.size, s.fill);
    }
}

// ── drawShape ─────────────────────────────────────────────────────────
function drawShape(type, x1, y1, x2, y2, color, size, fill) {
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash([]); ctx.beginPath();
    const w = x2 - x1, h = y2 - y1, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (type === 'rect') { ctx.rect(x1, y1, w, h); }
    else if (type === 'circle') { ctx.arc(cx, cy, Math.sqrt(w * w + h * h) / 2, 0, Math.PI * 2); }
    else if (type === 'triangle') { ctx.moveTo(cx, y1); ctx.lineTo(x1, y2); ctx.lineTo(x2, y2); ctx.closePath(); }
    else if (type === 'diamond') { ctx.moveTo(cx, y1); ctx.lineTo(x2, cy); ctx.lineTo(cx, y2); ctx.lineTo(x1, cy); ctx.closePath(); }
    else if (type === 'star') {
        const outerR = Math.min(Math.abs(w), Math.abs(h)) / 2, innerR = outerR / 2.5;
        for (let i = 0; i < 10; i++) {
            const a = (Math.PI / 5) * i - Math.PI / 2, r = i % 2 === 0 ? outerR : innerR;
            i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        ctx.closePath();
    }
    else if (type === 'line-shape') { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    else if (type === 'dotted-line') { ctx.setLineDash([size * 2, size * 3]); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    if (fill && type !== 'line-shape' && type !== 'dotted-line') ctx.fill(); else ctx.stroke();
    ctx.setLineDash([]);
}

// ── localDraw (smooth pen) ────────────────────────────────────────────
function localDraw(x, y, c, s) {
    ctx.lineWidth = s; ctx.strokeStyle = c; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const mx = (lastX + x) / 2, my = (lastY + y) / 2;
    ctx.quadraticCurveTo(lastX, lastY, mx, my); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mx, my); lastX = x; lastY = y;
}

// ── addTextInput ──────────────────────────────────────────────────────
function addTextInput(x, y) {
    const inp = document.createElement('input');
    const cr = canvas.getBoundingClientRect();
    inp.style.cssText = `position:fixed;left:${cr.left + x}px;top:${cr.top + y - 22}px;font-size:20px;min-width:80px;border:1.5px dashed #6366f1;outline:none;background:transparent;padding:2px 4px;`;
    document.body.appendChild(inp); inp.focus();
    inp.onkeydown = e => {
        if (e.key === 'Enter' && inp.value.trim()) {
            const color = document.getElementById('colorPicker').value;
            const fs = Math.max(12, currentSize * 3);
            ctx.fillStyle = color; ctx.font = `${fs}px Arial`;
            const tw = ctx.measureText(inp.value).width;
            saveUndo();
            ctx.fillText(inp.value, x, y);
            penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            shapeObjects.push({ type: 'text', x1: x, y1: y - fs, x2: x + tw, y2: y, color, size: currentSize, fill: false, text: inp.value, fontSize: fs });
            socket.emit('draw', { type: 'text', text: inp.value, x: x / canvas.width, y: y / canvas.height, color });
            document.body.removeChild(inp);
            selectedIdx = shapeObjects.length - 1; updateSelOverlay(); setTool('select');
        } else if (e.key === 'Escape') { document.body.removeChild(inp); }
    };
}

// ── Undo/Redo ─────────────────────────────────────────────────────────
function cloneID(id) { return id ? new ImageData(new Uint8ClampedArray(id.data), id.width, id.height) : null; }
function saveUndo() {
    undoStack.push({ pen: cloneID(penLayerData), shapes: JSON.parse(JSON.stringify(shapeObjects)) });
    redoStack = [];
}
function restoreState(st) {
    penLayerData = cloneID(st.pen); shapeObjects = JSON.parse(JSON.stringify(st.shapes));
    redrawAll(); selectedIdx = -1; updateSelOverlay();
}
function undo() { if (!undoStack.length) return; redoStack.push({ pen: cloneID(penLayerData), shapes: JSON.parse(JSON.stringify(shapeObjects)) }); restoreState(undoStack.pop()); socket.emit('sync-state', canvas.toDataURL()); }
function redo() { if (!redoStack.length) return; undoStack.push({ pen: cloneID(penLayerData), shapes: JSON.parse(JSON.stringify(shapeObjects)) }); restoreState(redoStack.pop()); socket.emit('sync-state', canvas.toDataURL()); }

// ── Hit test ──────────────────────────────────────────────────────────
function ptSegDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; if (!l2) return Math.hypot(px - ax, py - ay); const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
function hitTest(cx, cy) {
    for (let i = shapeObjects.length - 1; i >= 0; i--) {
        const s = shapeObjects[i];
        if (s.type === 'line-shape' || s.type === 'dotted-line') { if (ptSegDist(cx, cy, s.x1, s.y1, s.x2, s.y2) < 12) return i; }
        else { const x1 = Math.min(s.x1, s.x2) - 8, x2 = Math.max(s.x1, s.x2) + 8, y1 = Math.min(s.y1, s.y2) - 8, y2 = Math.max(s.y1, s.y2) + 8; if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) return i; }
    }
    return -1;
}

// ── Selection overlay ─────────────────────────────────────────────────
const selOverlay = document.getElementById('sel-overlay');
const selHandles = selOverlay.querySelectorAll('.sel-handle');
const selBody = selOverlay.querySelector('#sel-body');

function updateSelOverlay() {
    const has = selectedIdx >= 0 && selectedIdx < shapeObjects.length;
    if (!has) {
        selOverlay.style.display = 'none';
    } else {
        const s = shapeObjects[selectedIdx], pad = 8;
        const tl = toScreen(Math.min(s.x1, s.x2) - pad, Math.min(s.y1, s.y2) - pad);
        const br = toScreen(Math.max(s.x1, s.x2) + pad, Math.max(s.y1, s.y2) + pad);
        selOverlay.style.cssText = `display:block;position:fixed;left:${tl.x}px;top:${tl.y}px;width:${br.x - tl.x}px;height:${br.y - tl.y}px;border:2px solid #6366f1;border-radius:3px;pointer-events:none;z-index:50;`;
        selHandles.forEach(h => { h.style.pointerEvents = 'all'; });
        selBody.style.pointerEvents = 'all';
    }
    // Toggle layer buttons
    ['btn-front', 'btn-fwd', 'btn-bwd', 'btn-back'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = !has;
        btn.style.opacity = has ? '1' : '0.35';
    });
}

// ── Layer ordering ────────────────────────────────────────────────────
function bringToFront() {
    if (selectedIdx < 0 || selectedIdx >= shapeObjects.length - 1) return;
    saveUndo();
    shapeObjects.push(shapeObjects.splice(selectedIdx, 1)[0]);
    selectedIdx = shapeObjects.length - 1;
    redrawAll(); updateSelOverlay();
}
function sendToBack() {
    if (selectedIdx <= 0) return;
    saveUndo();
    shapeObjects.unshift(shapeObjects.splice(selectedIdx, 1)[0]);
    selectedIdx = 0;
    redrawAll(); updateSelOverlay();
}
function bringForward() {
    if (selectedIdx < 0 || selectedIdx >= shapeObjects.length - 1) return;
    saveUndo();
    [shapeObjects[selectedIdx], shapeObjects[selectedIdx + 1]] = [shapeObjects[selectedIdx + 1], shapeObjects[selectedIdx]];
    selectedIdx++;
    redrawAll(); updateSelOverlay();
}
function sendBackward() {
    if (selectedIdx <= 0) return;
    saveUndo();
    [shapeObjects[selectedIdx], shapeObjects[selectedIdx - 1]] = [shapeObjects[selectedIdx - 1], shapeObjects[selectedIdx]];
    selectedIdx--;
    redrawAll(); updateSelOverlay();
}

// Handle mousedown
selHandles.forEach(h => h.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    isResizingHandle = true; activeHandle = +h.dataset.h;
    dragStart = toCanvas(e.clientX, e.clientY); origShape = { ...shapeObjects[selectedIdx] };
    document.addEventListener('mousemove', onHDrag); document.addEventListener('mouseup', () => { isResizingHandle = false; document.removeEventListener('mousemove', onHDrag); saveUndo(); }, { once: true });
}));

// Body mousedown
selBody.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    isDraggingBody = true; dragStart = toCanvas(e.clientX, e.clientY); origShape = { ...shapeObjects[selectedIdx] };
    document.addEventListener('mousemove', onBDrag); document.addEventListener('mouseup', () => { isDraggingBody = false; document.removeEventListener('mousemove', onBDrag); saveUndo(); }, { once: true });
});

function onHDrag(e) {
    if (!isResizingHandle || selectedIdx < 0) return;
    const p = toCanvas(e.clientX, e.clientY), dx = p.x - dragStart.x, dy = p.y - dragStart.y;
    const s = { ...origShape };
    if (activeHandle === 0) { s.x1 += dx; s.y1 += dy; } else if (activeHandle === 1) { s.y1 += dy; } else if (activeHandle === 2) { s.x2 += dx; s.y1 += dy; }
    else if (activeHandle === 3) { s.x2 += dx; } else if (activeHandle === 4) { s.x2 += dx; s.y2 += dy; } else if (activeHandle === 5) { s.y2 += dy; }
    else if (activeHandle === 6) { s.x1 += dx; s.y2 += dy; } else if (activeHandle === 7) { s.x1 += dx; }
    shapeObjects[selectedIdx] = s; redrawAll(); updateSelOverlay();
}
function onBDrag(e) {
    if (!isDraggingBody || selectedIdx < 0) return;
    const p = toCanvas(e.clientX, e.clientY), dx = p.x - dragStart.x, dy = p.y - dragStart.y;
    shapeObjects[selectedIdx] = { ...origShape, x1: origShape.x1 + dx, y1: origShape.y1 + dy, x2: origShape.x2 + dx, y2: origShape.y2 + dy };
    redrawAll(); updateSelOverlay();
}

// Delete key
document.addEventListener('keydown', e => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx >= 0 && document.activeElement.tagName !== 'INPUT') {
        saveUndo(); shapeObjects.splice(selectedIdx, 1); selectedIdx = -1; redrawAll(); updateSelOverlay();
    }
});

// ── Canvas events ─────────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
    const p = toCanvas(e.clientX, e.clientY); startX = p.x; startY = p.y;
    // Always try to select a shape first — regardless of current tool
    const hit = hitTest(startX, startY);
    if (hit >= 0) { selectedIdx = hit; updateSelOverlay(); return; }
    // Clicked empty space — deselect and use current tool
    selectedIdx = -1; updateSelOverlay();
    if (currentTool === 'text') { addTextInput(startX, startY); return; }
    saveUndo(); lastX = startX; lastY = startY; drawing = true;
    snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (currentTool === 'pen' || currentTool === 'eraser') { ctx.beginPath(); ctx.moveTo(startX, startY); }
});

canvas.addEventListener('mousemove', e => {
    const p = toCanvas(e.clientX, e.clientY); const x = p.x, y = p.y;
    document.getElementById('cursor').style.left = `${e.clientX}px`;
    document.getElementById('cursor').style.top = `${e.clientY}px`;
    if (!drawing) return;
    const color = currentTool === 'eraser' ? 'white' : document.getElementById('colorPicker').value;
    if (currentTool === 'pen' || currentTool === 'eraser') {
        const px = lastX, py = lastY; localDraw(x, y, color, currentSize);
        socket.emit('draw', { type: 'line', x1: px / canvas.width, y1: py / canvas.height, x2: x / canvas.width, y2: y / canvas.height, color, size: currentSize });
    } else if (SHAPE_TOOLS.includes(currentTool)) {
        ctx.putImageData(snapshot, 0, 0); redrawShapes();
        drawShape(currentTool, startX, startY, x, y, color, currentSize, false);
    }
});

canvas.addEventListener('mouseup', e => {
    if (!drawing) return; drawing = false;
    const p = toCanvas(e.clientX, e.clientY);
    if (currentTool === 'pen' || currentTool === 'eraser') {
        penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else if (SHAPE_TOOLS.includes(currentTool)) {
        const color = document.getElementById('colorPicker').value;
        const s = { type: currentTool, x1: startX, y1: startY, x2: p.x, y2: p.y, color, size: currentSize, fill: false };
        shapeObjects.push(s);
        socket.emit('draw', { type: currentTool, x1: startX / canvas.width, y1: startY / canvas.height, x2: p.x / canvas.width, y2: p.y / canvas.height, color, size: currentSize, fill: false });
        selectedIdx = shapeObjects.length - 1; updateSelOverlay();
    }
});

// ── Tool setter ───────────────────────────────────────────────────────
function setTool(t) {
    currentTool = t;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const btnId = SHAPE_TOOLS.includes(t) ? 'shape-btn' : `${t}-btn`;
    const btn = document.getElementById(btnId); if (btn) btn.classList.add('active');
}

// ── Socket ────────────────────────────────────────────────────────────
socket.on('draw', d => {
    if (d.type === 'line') {
        ctx.beginPath(); ctx.moveTo(d.x1 * canvas.width, d.y1 * canvas.height);
        ctx.quadraticCurveTo(d.x1 * canvas.width, d.y1 * canvas.height, (d.x1 + d.x2) / 2 * canvas.width, (d.y1 + d.y2) / 2 * canvas.height);
        ctx.lineWidth = d.size; ctx.strokeStyle = d.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
        penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else if (d.type === 'text') {
        ctx.fillStyle = d.color; ctx.font = '20px Arial'; ctx.fillText(d.text, d.x * canvas.width, d.y * canvas.height);
        penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else {
        drawShape(d.type, d.x1 * canvas.width, d.y1 * canvas.height, d.x2 * canvas.width, d.y2 * canvas.height, d.color, d.size, d.fill);
        penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
});
socket.on('sync-state', url => { const img = new Image(); img.src = url; img.onload = () => { ctx.drawImage(img, 0, 0); penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height); }; });
socket.on('chat-message', d => { const li = document.createElement('li'); li.textContent = `${d.user}: ${d.text}`; document.getElementById('chat-messages').appendChild(li); });
socket.on('clear', () => { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height); shapeObjects = []; selectedIdx = -1; updateSelOverlay(); });

// ── Room / Session ────────────────────────────────────────────────────
function generateRoomId() { return Math.random().toString(36).substr(2, 6).toUpperCase(); }
function copyRoomId() { const id = document.getElementById('room-id-input').value; navigator.clipboard.writeText(id).then(() => { const btn = document.querySelector('.copy-btn'), orig = btn.textContent; btn.textContent = '✅ Copied!'; setTimeout(() => btn.textContent = orig, 2000); }); }
function joinSession() { const ni = document.getElementById('username-input'), name = ni.value.trim(), roomId = document.getElementById('room-id-input').value.trim().toUpperCase(); if (!name) { ni.style.borderColor = '#e74c3c'; ni.focus(); setTimeout(() => ni.style.borderColor = '', 1500); return; } if (roomId) { myUserName = name; document.getElementById('login-overlay').style.display = 'none'; document.getElementById('room-id').value = roomId; socket.emit('join-room', roomId); socket.emit('new-user', myUserName); } }
function changeRoom() { const r = document.getElementById('room-id').value.trim().toUpperCase(); if (r && myUserName) { socket.emit('join-room', r); socket.emit('new-user', myUserName); } }
document.getElementById('room-id-input').value = generateRoomId();

// ── Misc ──────────────────────────────────────────────────────────────
function sendMessage() { const t = document.getElementById('chat-input').value.trim(); if (t && myUserName) { socket.emit('chat-message', { user: myUserName, text: t }); document.getElementById('chat-messages').appendChild(Object.assign(document.createElement('li'), { textContent: `You: ${t}` })); document.getElementById('chat-input').value = ''; } }
function clearBoard() { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); penLayerData = ctx.getImageData(0, 0, canvas.width, canvas.height); shapeObjects = []; selectedIdx = -1; updateSelOverlay(); socket.emit('clear'); }
function saveImage() { const a = document.createElement('a'); a.download = 'whiteboard.png'; a.href = canvas.toDataURL(); a.click(); }
function updateSize(val) { currentSize = parseInt(val); document.getElementById('sizeLabel').textContent = val + 'px'; const c = document.getElementById('cursor'); c.style.width = val + 'px'; c.style.height = val + 'px'; }
updateSize(5);