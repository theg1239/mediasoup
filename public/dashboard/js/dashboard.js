let socket;
let authenticated = false;
let userEmail = '';
let charts = {};
let statsInterval;
let roomsData = {};
let breakoutRoomsData = {};

const chartColors = {
    primary: '#bb86fc',
    secondary: '#03dac6',
    success: '#00c853',
    danger: '#cf6679',
    warning: '#ffab00',
    info: '#2196f3',
    text: '#e0e0e0',
    gridLines: 'rgba(255, 255, 255, 0.1)'
};

const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const emailInput = document.getElementById('email');
const secretInput = document.getElementById('secret');
const userEmailDisplay = document.getElementById('user-email');
const logoutBtn = document.getElementById('logout-btn');
const killswitchToggle = document.getElementById('killswitch-toggle');
const settingsKillswitchToggle = document.getElementById('settings-killswitch-toggle');
const saveKillswitchBtn = document.getElementById('save-killswitch');
const refreshRoomsBtn = document.getElementById('refresh-rooms');
const refreshBreakoutRoomsBtn = document.getElementById('refresh-breakout-rooms');
const roomsTableBody = document.getElementById('rooms-table-body');
const breakoutRoomsTableBody = document.getElementById('breakout-rooms-table-body');
const modalRoomId = document.getElementById('modal-room-id');
const modalUsersTableBody = document.getElementById('modal-users-table-body');
const closeRoomBtn = document.getElementById('close-room-btn');

document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    checkAuthentication();
});

function initializeEventListeners() {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        login();
    });

    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        logout();
    });

    killswitchToggle.addEventListener('change', () => {
        toggleKillswitch(killswitchToggle.checked);
        settingsKillswitchToggle.checked = killswitchToggle.checked;
    });

    settingsKillswitchToggle.addEventListener('change', () => {
        killswitchToggle.checked = settingsKillswitchToggle.checked;
    });

    saveKillswitchBtn.addEventListener('click', () => {
        toggleKillswitch(settingsKillswitchToggle.checked);
    });

    refreshRoomsBtn.addEventListener('click', () => {
        refreshRooms();
    });

    refreshBreakoutRoomsBtn.addEventListener('click', () => {
        refreshBreakoutRooms();
    });

    closeRoomBtn.addEventListener('click', () => {
        const roomId = modalRoomId.textContent;
        closeRoom(roomId);
    });
}

function checkAuthentication() {
    const storedEmail = localStorage.getItem('mediasoup_admin_email');
    const storedToken = localStorage.getItem('mediasoup_admin_token');
    
    if (storedEmail && storedToken) {
        authenticateWithToken(storedEmail, storedToken);
    }
}

function login() {
    const email = emailInput.value.trim();
    const secret = secretInput.value.trim();
    
    if (!email || !secret) {
        showLoginError('Please enter both email and secret');
        return;
    }
    
    socket = io({
        auth: {
            email,
            secret
        }
    });
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('connect_error', (err) => {
        console.error('Connection error:', err);
        showLoginError('Connection error: ' + err.message);
        socket.disconnect();
    });
    
    socket.on('auth_success', (data) => {
        authenticated = true;
        userEmail = email;
        
        localStorage.setItem('mediasoup_admin_email', email);
        localStorage.setItem('mediasoup_admin_token', data.token);
        
        showDashboard();
        
        initializeDashboard();
    });
    
    socket.on('auth_error', (err) => {
        console.error('Authentication error:', err);
        showLoginError('Authentication failed: ' + err.message);
        socket.disconnect();
    });
}

function authenticateWithToken(email, token) {
    socket = io({
        auth: {
            email,
            token
        }
    });
    
    socket.on('connect', () => {
        console.log('Connected to server with token');
    });
    
    socket.on('connect_error', (err) => {
        console.error('Token connection error:', err);
        localStorage.removeItem('mediasoup_admin_email');
        localStorage.removeItem('mediasoup_admin_token');
    });
    
    socket.on('auth_success', () => {
        authenticated = true;
        userEmail = email;
        showDashboard();
        initializeDashboard();
    });
    
    socket.on('auth_error', () => {
        localStorage.removeItem('mediasoup_admin_email');
        localStorage.removeItem('mediasoup_admin_token');
    });
}

function logout() {
    if (socket) {
        socket.disconnect();
    }
    
    localStorage.removeItem('mediasoup_admin_email');
    localStorage.removeItem('mediasoup_admin_token');
    
    if (statsInterval) {
        clearInterval(statsInterval);
    }
    
    authenticated = false;
    userEmail = '';
    
    showLogin();
}

function showLoginError(message) {
    loginError.textContent = message;
    loginError.classList.remove('d-none');
}

function showDashboard() {
    loginContainer.classList.add('d-none');
    dashboardContainer.classList.remove('d-none');
    userEmailDisplay.textContent = userEmail;
}

function showLogin() {
    dashboardContainer.classList.add('d-none');
    loginContainer.classList.remove('d-none');
    loginError.classList.add('d-none');
    emailInput.value = '';
    secretInput.value = '';
}

function initializeDashboard() {
    setupSocketListeners();
    
    initializeCharts();
    
    requestServerStats();
    refreshRooms();
    refreshBreakoutRooms();
    
    statsInterval = setInterval(requestServerStats, 5000);
}

function setupSocketListeners() {
    socket.on('server_stats', (data) => {
        updateDashboardStats(data);
    });
    
    socket.on('rooms_data', (data) => {
        updateRoomsTable(data);
    });
    
    socket.on('breakout_rooms_data', (data) => {
        updateBreakoutRoomsTable(data);
    });
    
    socket.on('room_closed', (data) => {
        showNotification(`Room ${data.roomId} has been closed`);
        refreshRooms();
        refreshBreakoutRooms();
    });
    
    socket.on('server-status-change', (data) => {
        updateKillswitchStatus(data.useAlternativeMeetingLinks);
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showNotification('Disconnected from server. Trying to reconnect...');
    });
}

function initializeCharts() {
    Chart.defaults.color = chartColors.text;
    Chart.defaults.borderColor = chartColors.gridLines;
    
    const cpuCtx = document.getElementById('cpu-chart').getContext('2d');
    charts.cpu = new Chart(cpuCtx, {
        type: 'line',
        data: {
            labels: Array(10).fill(''),
            datasets: [{
                label: 'CPU Usage (%)',
                data: Array(10).fill(0),
                borderColor: chartColors.primary,
                backgroundColor: hexToRgba(chartColors.primary, 0.2),
                tension: 0.4,
                fill: true,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    grid: {
                        color: chartColors.gridLines
                    },
                    ticks: {
                        color: chartColors.text
                    }
                },
                x: {
                    grid: {
                        color: chartColors.gridLines
                    },
                    ticks: {
                        color: chartColors.text
                    }
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: chartColors.text
                    }
                }
            },
            animation: {
                duration: 500
            }
        }
    });
    
    const memoryCtx = document.getElementById('memory-chart').getContext('2d');
    charts.memory = new Chart(memoryCtx, {
        type: 'line',
        data: {
            labels: Array(10).fill(''),
            datasets: [{
                label: 'Memory Usage (MB)',
                data: Array(10).fill(0),
                borderColor: chartColors.secondary,
                backgroundColor: hexToRgba(chartColors.secondary, 0.2),
                tension: 0.4,
                fill: true,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: chartColors.gridLines
                    },
                    ticks: {
                        color: chartColors.text
                    }
                },
                x: {
                    grid: {
                        color: chartColors.gridLines
                    },
                    ticks: {
                        color: chartColors.text
                    }
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: chartColors.text
                    }
                }
            },
            animation: {
                duration: 500
            }
        }
    });
    
    const networkCtx = document.getElementById('network-chart').getContext('2d');
    charts.network = new Chart(networkCtx, {
        type: 'line',
        data: {
            labels: Array(10).fill(''),
            datasets: [
                {
                    label: 'Network In (KB/s)',
                    data: Array(10).fill(0),
                    borderColor: chartColors.info,
                    backgroundColor: hexToRgba(chartColors.info, 0.2),
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2
                },
                {
                    label: 'Network Out (KB/s)',
                    data: Array(10).fill(0),
                    borderColor: chartColors.danger,
                    backgroundColor: hexToRgba(chartColors.danger, 0.2),
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: chartColors.gridLines
                    },
                    ticks: {
                        color: chartColors.text
                    }
                },
                x: {
                    grid: {
                        color: chartColors.gridLines
                    },
                    ticks: {
                        color: chartColors.text
                    }
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: chartColors.text
                    }
                }
            },
            animation: {
                duration: 500
            }
        }
    });
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function requestServerStats() {
    if (socket && socket.connected) {
        socket.emit('get_server_stats');
    }
}

function refreshRooms() {
    if (socket && socket.connected) {
        refreshRoomsBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-2 refreshing"></i>Refreshing...';
        socket.emit('get_rooms');
    }
}

function refreshBreakoutRooms() {
    if (socket && socket.connected) {
        refreshBreakoutRoomsBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-2 refreshing"></i>Refreshing...';
        socket.emit('get_breakout_rooms');
    }
}

function toggleKillswitch(enabled) {
    if (socket && socket.connected) {
        socket.emit('toggle_killswitch', { enabled });
    }
}

function closeRoom(roomId) {
    if (socket && socket.connected) {
        if (confirm(`Are you sure you want to close room ${roomId}?`)) {
            socket.emit('close_room', { roomId });
            
            const modal = bootstrap.Modal.getInstance(document.getElementById('room-details-modal'));
            if (modal) {
                modal.hide();
            }
        }
    }
}

function updateDashboardStats(data) {
    document.getElementById('active-rooms-count').textContent = data.roomsCount || 0;
    document.getElementById('active-users-count').textContent = data.usersCount || 0;
    document.getElementById('workers-count').textContent = data.workersCount || 0;
    
    updateKillswitchStatus(data.useAlternativeMeetingLinks);
    
    document.getElementById('hostname').textContent = data.hostname || '-';
    document.getElementById('platform').textContent = data.platform || '-';
    document.getElementById('cpu-cores').textContent = data.cpuCores || '-';
    document.getElementById('total-memory').textContent = formatBytes(data.totalMemory) || '-';
    document.getElementById('uptime').textContent = formatUptime(data.uptime) || '-';
    
    updateWorkerStatus(data.workers || []);
    
    updateNetworkInterfaces(data.networkInterfaces || {});
    
    updateCharts(data);
}

function updateKillswitchStatus(enabled) {
    killswitchToggle.checked = enabled;
    settingsKillswitchToggle.checked = enabled;
    document.getElementById('killswitch-status').textContent = enabled ? 'Enabled' : 'Disabled';
}

function updateWorkerStatus(workers) {
    const workersStatusContainer = document.getElementById('workers-status');
    workersStatusContainer.innerHTML = '';
    
    workers.forEach((worker, index) => {
        const workerElement = document.createElement('div');
        workerElement.className = 'mb-3';
        
        const loadPercentage = worker.load || 0;
        
        workerElement.innerHTML = `
            <div class="d-flex justify-content-between align-items-center">
                <span><i class="bi bi-cpu me-2"></i>Worker ${index + 1} (PID: ${worker.pid})</span>
                <span>${loadPercentage}%</span>
            </div>
            <div class="worker-load">
                <div class="worker-load-bar" style="width: ${loadPercentage}%"></div>
            </div>
        `;
        
        workersStatusContainer.appendChild(workerElement);
    });
}

function updateNetworkInterfaces(interfaces) {
    const networkInterfacesContainer = document.getElementById('network-interfaces');
    networkInterfacesContainer.innerHTML = '';
    
    for (const [name, data] of Object.entries(interfaces)) {
        const interfaceElement = document.createElement('div');
        interfaceElement.className = 'mb-3';
        
        interfaceElement.innerHTML = `
            <h6><i class="bi bi-hdd-network me-2"></i>${name}</h6>
            <table class="table table-sm">
                <tbody>
                    ${data.map(addr => `
                        <tr>
                            <td>${addr.family}</td>
                            <td>${addr.address}</td>
                            <td>${addr.internal ? 'Internal' : 'External'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        
        networkInterfacesContainer.appendChild(interfaceElement);
    }
}

function updateCharts(data) {
    const timestamp = new Date().toLocaleTimeString();
    
    if (charts.cpu) {
        charts.cpu.data.labels.shift();
        charts.cpu.data.labels.push(timestamp);
        charts.cpu.data.datasets[0].data.shift();
        charts.cpu.data.datasets[0].data.push(data.cpuUsage || 0);
        charts.cpu.update();
    }
    
    if (charts.memory) {
        charts.memory.data.labels.shift();
        charts.memory.data.labels.push(timestamp);
        charts.memory.data.datasets[0].data.shift();
        charts.memory.data.datasets[0].data.push(data.memoryUsage ? data.memoryUsage / (1024 * 1024) : 0);
        charts.memory.update();
    }
    
    if (charts.network) {
        charts.network.data.labels.shift();
        charts.network.data.labels.push(timestamp);
        charts.network.data.datasets[0].data.shift();
        charts.network.data.datasets[0].data.push(data.networkIn ? data.networkIn / 1024 : 0);
        charts.network.data.datasets[1].data.shift();
        charts.network.data.datasets[1].data.push(data.networkOut ? data.networkOut / 1024 : 0);
        charts.network.update();
    }
}

function updateRoomsTable(data) {
    roomsData = data;
    roomsTableBody.innerHTML = '';
    refreshRoomsBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-2"></i>Refresh';
    
    if (data.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="5" class="text-center">No active rooms</td>';
        roomsTableBody.appendChild(row);
        return;
    }
    
    data.forEach(room => {
        const row = document.createElement('tr');
        
        const createdAt = new Date(room.createdAt).toLocaleString();
        
        row.innerHTML = `
            <td><span class="status-indicator status-active"></span>${room.roomId}</td>
            <td>${room.users.length}</td>
            <td>${createdAt}</td>
            <td>Worker ${room.workerId}</td>
            <td>
                <button class="btn btn-sm btn-primary view-room-btn" data-room-id="${room.roomId}">
                    <i class="bi bi-eye"></i> View
                </button>
                <button class="btn btn-sm btn-danger close-room-btn" data-room-id="${room.roomId}">
                    <i class="bi bi-x-circle"></i> Close
                </button>
            </td>
        `;
        
        roomsTableBody.appendChild(row);
    });
    
    document.querySelectorAll('.view-room-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const roomId = btn.getAttribute('data-room-id');
            showRoomDetails(roomId);
        });
    });
    
    document.querySelectorAll('.close-room-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const roomId = btn.getAttribute('data-room-id');
            closeRoom(roomId);
        });
    });
}

function updateBreakoutRoomsTable(data) {
    breakoutRoomsData = data;
    breakoutRoomsTableBody.innerHTML = '';
    refreshBreakoutRoomsBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-2"></i>Refresh';
    
    if (data.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="5" class="text-center">No active breakout rooms</td>';
        breakoutRoomsTableBody.appendChild(row);
        return;
    }
    
    data.forEach(room => {
        const row = document.createElement('tr');
        
        const createdAt = new Date(room.createdAt).toLocaleString();
        
        row.innerHTML = `
            <td>${room.mainRoomId}</td>
            <td><span class="status-indicator status-active"></span>${room.roomId}</td>
            <td>${room.users.length}</td>
            <td>${createdAt}</td>
            <td>
                <button class="btn btn-sm btn-primary view-breakout-room-btn" data-room-id="${room.roomId}">
                    <i class="bi bi-eye"></i> View
                </button>
                <button class="btn btn-sm btn-danger close-breakout-room-btn" data-room-id="${room.roomId}">
                    <i class="bi bi-x-circle"></i> Close
                </button>
            </td>
        `;
        
        breakoutRoomsTableBody.appendChild(row);
    });
    
    document.querySelectorAll('.view-breakout-room-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const roomId = btn.getAttribute('data-room-id');
            showRoomDetails(roomId, true);
        });
    });
    
    document.querySelectorAll('.close-breakout-room-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const roomId = btn.getAttribute('data-room-id');
            closeRoom(roomId);
        });
    });
}

function showRoomDetails(roomId, isBreakout = false) {
    const roomData = isBreakout 
        ? breakoutRoomsData.find(r => r.roomId === roomId)
        : roomsData.find(r => r.roomId === roomId);
    
    if (!roomData) {
        showNotification('Room data not found');
        return;
    }
    
    modalRoomId.textContent = roomId;
    modalUsersTableBody.innerHTML = '';
    
    roomData.users.forEach(user => {
        const row = document.createElement('tr');
        
        row.innerHTML = `
            <td>${user.id}</td>
            <td>${user.displayName || 'Anonymous'}</td>
            <td>${user.role || 'Participant'}</td>
            <td>
                <button class="btn btn-sm btn-danger kick-user-btn" data-user-id="${user.id}" data-room-id="${roomId}">
                    <i class="bi bi-box-arrow-right"></i> Kick
                </button>
            </td>
        `;
        
        modalUsersTableBody.appendChild(row);
    });
    
    document.querySelectorAll('.kick-user-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = btn.getAttribute('data-user-id');
            const roomId = btn.getAttribute('data-room-id');
            kickUser(roomId, userId);
        });
    });
    
    const modal = new bootstrap.Modal(document.getElementById('room-details-modal'));
    modal.show();
}

function kickUser(roomId, userId) {
    if (socket && socket.connected) {
        if (confirm(`Are you sure you want to kick user ${userId} from room ${roomId}?`)) {
            socket.emit('kick_user', { roomId, userId });
        }
    }
}

function showNotification(message) {
    console.log('Notification:', message);
    
    const toastContainer = document.createElement('div');
    toastContainer.className = 'position-fixed bottom-0 end-0 p-3';
    toastContainer.style.zIndex = '5';
    
    const toastElement = document.createElement('div');
    toastElement.className = 'toast';
    toastElement.setAttribute('role', 'alert');
    toastElement.setAttribute('aria-live', 'assertive');
    toastElement.setAttribute('aria-atomic', 'true');
    
    toastElement.innerHTML = `
        <div class="toast-header">
            <i class="bi bi-info-circle me-2"></i>
            <strong class="me-auto">MediaSoup Dashboard</strong>
            <small>Just now</small>
            <button type="button" class="btn-close" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body">
            ${message}
        </div>
    `;
    
    toastContainer.appendChild(toastElement);
    document.body.appendChild(toastContainer);
    
    const toast = new bootstrap.Toast(toastElement);
    toast.show();
    
    toastElement.addEventListener('hidden.bs.toast', () => {
        document.body.removeChild(toastContainer);
    });
}

function formatBytes(bytes, decimals = 2) {
    if (!bytes) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    if (!seconds) return '0s';
    
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    let result = '';
    if (days > 0) result += `${days}d `;
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m `;
    if (secs > 0 || result === '') result += `${secs}s`;
    
    return result.trim();
} 