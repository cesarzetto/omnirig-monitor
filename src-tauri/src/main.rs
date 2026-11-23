// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Components, Disks, Networks, ProcessesToUpdate, System};
use tauri::State;

pub struct AppState {
    pub sys: Mutex<System>,
    pub disks: Mutex<Disks>,
    pub networks: Mutex<Networks>,
    pub components: Mutex<Components>,
}

#[derive(Serialize, Clone)]
pub struct CoreMetric {
    pub id: usize,
    pub name: String,
    pub usage: f32,
    pub frequency: u64,
}

#[derive(Serialize, Clone)]
pub struct DiskMetric {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    pub kind: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub available_gb: f64,
    pub usage_percent: f64,
    pub is_removable: bool,
}

#[derive(Serialize, Clone)]
pub struct NetInterfaceMetric {
    pub name: String,
    pub received_kb: f64,
    pub transmitted_kb: f64,
    pub total_rx_mb: f64,
    pub total_tx_mb: f64,
    pub mac_address: String,
}

#[derive(Serialize, Clone)]
pub struct SensorMetric {
    pub label: String,
    pub temp_c: f32,
    pub max_c: f32,
    pub critical_c: Option<f32>,
}

#[derive(Serialize, Clone)]
pub struct ProcessMetric {
    pub pid: u32,
    pub name: String,
    pub cpu_usage: f32,
    pub memory_mb: f64,
}

#[derive(Serialize, Clone)]
pub struct TelemetrySnapshot {
    pub host_name: String,
    pub os_name: String,
    pub os_version: String,
    pub kernel_version: String,
    pub uptime_seconds: u64,
    pub cpu_brand: String,
    pub cpu_physical_cores: usize,
    pub cpu_logical_cores: usize,
    pub cpu_global_usage: f32,
    pub cpu_avg_freq_mhz: u64,
    pub cores: Vec<CoreMetric>,
    pub ram_total_gb: f64,
    pub ram_used_gb: f64,
    pub ram_available_gb: f64,
    pub ram_usage_percent: f64,
    pub swap_total_gb: f64,
    pub swap_used_gb: f64,
    pub disks: Vec<DiskMetric>,
    pub networks: Vec<NetInterfaceMetric>,
    pub sensors: Vec<SensorMetric>,
    pub top_processes: Vec<ProcessMetric>,
    pub local_ip: String,
}

fn detect_local_ip() -> String {
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

#[tauri::command]
fn get_telemetry(state: State<'_, AppState>, include_processes: bool) -> TelemetrySnapshot {
    let mut sys = state.sys.lock().unwrap();
    let mut disks = state.disks.lock().unwrap();
    let mut networks = state.networks.lock().unwrap();
    let mut components = state.components.lock().unwrap();

    // Fast, low-overhead refresh
    sys.refresh_cpu_all();
    sys.refresh_memory();
    disks.refresh();
    networks.refresh();
    components.refresh();

    let cpus = sys.cpus();
    let cpu_brand = cpus
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Generic x86_64 Processor".to_string());

    let cpu_global_usage = sys.global_cpu_usage();
    let mut total_freq = 0u64;

    let cores: Vec<CoreMetric> = cpus
        .iter()
        .enumerate()
        .map(|(idx, c)| {
            total_freq += c.frequency();
            CoreMetric {
                id: idx,
                name: format!("Core #{}", idx),
                usage: c.cpu_usage(),
                frequency: c.frequency(),
            }
        })
        .collect();

    let cpu_avg_freq_mhz = if !cores.is_empty() {
        total_freq / (cores.len() as u64)
    } else {
        0
    };

    let bytes_to_gb = 1_073_741_824.0_f64;
    let ram_total_gb = (sys.total_memory() as f64) / bytes_to_gb;
    let ram_used_gb = (sys.used_memory() as f64) / bytes_to_gb;
    let ram_available_gb = (sys.available_memory() as f64) / bytes_to_gb;
    let ram_usage_percent = if ram_total_gb > 0.0 {
        (ram_used_gb / ram_total_gb) * 100.0
    } else {
        0.0
    };

    let swap_total_gb = (sys.total_swap() as f64) / bytes_to_gb;
    let swap_used_gb = (sys.used_swap() as f64) / bytes_to_gb;

    let disk_metrics: Vec<DiskMetric> = disks
        .list()
        .iter()
        .map(|d| {
            let total = (d.total_space() as f64) / bytes_to_gb;
            let avail = (d.available_space() as f64) / bytes_to_gb;
            let used = (total - avail).max(0.0);
            let pct = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
            DiskMetric {
                name: d.name().to_string_lossy().to_string(),
                mount_point: d.mount_point().to_string_lossy().to_string(),
                file_system: d.file_system().to_string_lossy().to_string(),
                kind: format!("{:?}", d.kind()),
                total_gb: total,
                used_gb: used,
                available_gb: avail,
                usage_percent: pct,
                is_removable: d.is_removable(),
            }
        })
        .collect();

    let net_metrics: Vec<NetInterfaceMetric> = networks
        .iter()
        .map(|(name, data)| NetInterfaceMetric {
            name: name.clone(),
            received_kb: (data.received() as f64) / 1024.0,
            transmitted_kb: (data.transmitted() as f64) / 1024.0,
            total_rx_mb: (data.total_received() as f64) / 1_048_576.0,
            total_tx_mb: (data.total_transmitted() as f64) / 1_048_576.0,
            mac_address: data.mac_address().to_string(),
        })
        .collect();

    let sensor_metrics: Vec<SensorMetric> = components
        .iter()
        .map(|c| SensorMetric {
            label: c.label().to_string(),
            temp_c: c.temperature(),
            max_c: c.max(),
            critical_c: c.critical(),
        })
        .collect();

    let mut top_processes = Vec::new();
    if include_processes {
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let logical_cores = cores.len().max(1) as f32;
        let mut procs: Vec<ProcessMetric> = sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcessMetric {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                cpu_usage: p.cpu_usage() / logical_cores,
                memory_mb: (p.memory() as f64) / 1_048_576.0,
            })
            .collect();
        procs.sort_by(|a, b| {
            b.cpu_usage
                .partial_cmp(&a.cpu_usage)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        procs.truncate(15);
        top_processes = procs;
    }

    TelemetrySnapshot {
        host_name: System::host_name().unwrap_or_else(|| "Windows-PC".to_string()),
        os_name: System::name().unwrap_or_else(|| "Windows".to_string()),
        os_version: System::os_version().unwrap_or_else(|| "10/11".to_string()),
        kernel_version: System::kernel_version().unwrap_or_else(|| "NT".to_string()),
        uptime_seconds: System::uptime(),
        cpu_brand,
        cpu_physical_cores: sys.physical_core_count().unwrap_or(cores.len()),
        cpu_logical_cores: cores.len(),
        cpu_global_usage,
        cpu_avg_freq_mhz,
        cores,
        ram_total_gb,
        ram_used_gb,
        ram_available_gb,
        ram_usage_percent,
        swap_total_gb,
        swap_used_gb,
        disks: disk_metrics,
        networks: net_metrics,
        sensors: sensor_metrics,
        top_processes,
        local_ip: detect_local_ip(),
    }
}

#[derive(Serialize)]
pub struct DiskBenchResult {
    pub target_path: String,
    pub test_size_mb: usize,
    pub seq_write_mb_s: f64,
    pub seq_read_mb_s: f64,
    pub rand_4k_write_mb_s: f64,
    pub rand_4k_read_mb_s: f64,
    pub rand_4k_iops_read: f64,
    pub rand_4k_iops_write: f64,
}

#[tauri::command]
async fn run_disk_benchmark(mount_point: String, size_mb: usize) -> Result<DiskBenchResult, String> {
    let clamped_mb = size_mb.clamp(16, 512);
    let mut base_path = PathBuf::from(&mount_point);
    if !base_path.exists() {
        base_path = std::env::temp_dir();
    }
    let bench_file = base_path.join(".omnirig_diskmark_temp.bin");

    // 1 MB buffer for sequential tests
    let block_1m = vec![0xA5u8; 1024 * 1024];

    // Sequential Write
    let start_seq_w = Instant::now();
    {
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&bench_file)
            .map_err(|e| format!("Permissão negada ou erro ao criar arquivo de teste em {}: {}", mount_point, e))?;
        for _ in 0..clamped_mb {
            f.write_all(&block_1m).map_err(|e| e.to_string())?;
        }
        f.sync_all().map_err(|e| e.to_string())?;
    }
    let seq_w_elapsed = start_seq_w.elapsed().as_secs_f64().max(0.001);
    let seq_write_mb_s = (clamped_mb as f64) / seq_w_elapsed;

    // Sequential Read
    let mut read_buf_1m = vec![0u8; 1024 * 1024];
    let start_seq_r = Instant::now();
    {
        let mut f = File::open(&bench_file).map_err(|e| e.to_string())?;
        while f.read(&mut read_buf_1m).map_err(|e| e.to_string())? > 0 {}
    }
    let seq_r_elapsed = start_seq_r.elapsed().as_secs_f64().max(0.001);
    let seq_read_mb_s = (clamped_mb as f64) / seq_r_elapsed;

    // 4K Block test (2048 operations = 8 MB)
    let block_4k = vec![0x5Au8; 4096];
    let ops_4k = 2048usize;
    let total_4k_mb = (ops_4k * 4096) as f64 / (1024.0 * 1024.0);

    let start_4k_w = Instant::now();
    {
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&bench_file)
            .map_err(|e| e.to_string())?;
        for _ in 0..ops_4k {
            f.write_all(&block_4k).map_err(|e| e.to_string())?;
        }
        f.sync_all().map_err(|e| e.to_string())?;
    }
    let w4k_elapsed = start_4k_w.elapsed().as_secs_f64().max(0.001);
    let rand_4k_write_mb_s = total_4k_mb / w4k_elapsed;
    let rand_4k_iops_write = (ops_4k as f64) / w4k_elapsed;

    let mut read_buf_4k = vec![0u8; 4096];
    let start_4k_r = Instant::now();
    {
        let mut f = File::open(&bench_file).map_err(|e| e.to_string())?;
        for _ in 0..ops_4k {
            let _ = f.read(&mut read_buf_4k).map_err(|e| e.to_string())?;
        }
    }
    let r4k_elapsed = start_4k_r.elapsed().as_secs_f64().max(0.001);
    let rand_4k_read_mb_s = total_4k_mb / r4k_elapsed;
    let rand_4k_iops_read = (ops_4k as f64) / r4k_elapsed;

    let _ = fs::remove_file(&bench_file);

    Ok(DiskBenchResult {
        target_path: mount_point,
        test_size_mb: clamped_mb,
        seq_write_mb_s,
        seq_read_mb_s,
        rand_4k_write_mb_s,
        rand_4k_read_mb_s,
        rand_4k_iops_read,
        rand_4k_iops_write,
    })
}

#[derive(Serialize, Clone)]
pub struct ScannedHost {
    pub ip: String,
    pub latency_ms: u64,
    pub open_ports: Vec<u16>,
    pub device_hint: String,
}

#[tauri::command]
async fn scan_subnet(subnet_prefix: String) -> Result<Vec<ScannedHost>, String> {
    let parts: Vec<&str> = subnet_prefix.trim().split('.').collect();
    if parts.len() < 3 {
        return Err("Prefixo de sub-rede inválido. Use o formato ex: 192.168.1".to_string());
    }
    let base = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
    let probe_ports: [u16; 7] = [80, 443, 445, 22, 3389, 8080, 53];

    let mut handles = Vec::with_capacity(254);

    for host_id in 1..=254u8 {
        let ip_str = format!("{}.{}", base, host_id);
        handles.push(tokio::spawn(async move {
            let ip: IpAddr = match ip_str.parse::<Ipv4Addr>() {
                Ok(v4) => IpAddr::V4(v4),
                Err(_) => return None,
            };

            let mut open_ports = Vec::new();
            let mut best_latency = u64::MAX;

            for &port in &probe_ports {
                let addr = SocketAddr::new(ip, port);
                let start = Instant::now();
                if let Ok(Ok(_)) = tokio::time::timeout(
                    Duration::from_millis(140),
                    tokio::net::TcpStream::connect(addr),
                )
                .await
                {
                    let elapsed = start.elapsed().as_millis() as u64;
                    if elapsed < best_latency {
                        best_latency = elapsed;
                    }
                    open_ports.push(port);
                }
            }

            if !open_ports.is_empty() {
                let hint = if open_ports.contains(&53) {
                    "Roteador / DNS Gateway"
                } else if open_ports.contains(&3389) || open_ports.contains(&445) {
                    "Windows PC / SMB Server"
                } else if open_ports.contains(&22) {
                    "Linux / SSH Host"
                } else if open_ports.contains(&80) || open_ports.contains(&443) {
                    "Web / IoT Device"
                } else {
                    "Dispositivo Ativo"
                };

                Some(ScannedHost {
                    ip: ip_str,
                    latency_ms: best_latency.max(1),
                    open_ports,
                    device_hint: hint.to_string(),
                })
            } else {
                None
            }
        }));
    }

    let mut found = Vec::new();
    for h in handles {
        if let Ok(Some(host)) = h.await {
            found.push(host);
        }
    }

    Ok(found)
}

#[derive(Serialize, Clone)]
pub struct DirEntryStat {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub size_mb: f64,
    pub file_count: u64,
    pub percentage: f64,
    pub is_dir: bool,
}

fn compute_dir_size(path: &std::path::Path, max_depth: usize, current_depth: usize) -> (u64, u64) {
    if current_depth > max_depth {
        return (0, 0);
    }
    let mut total_size = 0u64;
    let mut count = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_size += meta.len();
                    count += 1;
                } else if meta.is_dir() && !meta.file_type().is_symlink() {
                    let (sub_s, sub_c) = compute_dir_size(&entry.path(), max_depth, current_depth + 1);
                    total_size += sub_s;
                    count += sub_c;
                }
            }
        }
    }
    (total_size, count)
}

#[tauri::command]
async fn analyze_directory(target_dir: String) -> Result<Vec<DirEntryStat>, String> {
    let root = PathBuf::from(&target_dir);
    if !root.exists() {
        return Err(format!("Diretório não encontrado: {}", target_dir));
    }

    let entries = fs::read_dir(&root).map_err(|e| format!("Erro ao ler diretório: {}", e))?;
    let mut stats = Vec::new();
    let mut grand_total = 0u64;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                let sz = meta.len();
                grand_total += sz;
                stats.push(DirEntryStat {
                    name,
                    path: path.to_string_lossy().to_string(),
                    size_bytes: sz,
                    size_mb: (sz as f64) / 1_048_576.0,
                    file_count: 1,
                    percentage: 0.0,
                    is_dir: false,
                });
            } else if meta.is_dir() {
                let (sz, cnt) = compute_dir_size(&path, 4, 0);
                grand_total += sz;
                stats.push(DirEntryStat {
                    name,
                    path: path.to_string_lossy().to_string(),
                    size_bytes: sz,
                    size_mb: (sz as f64) / 1_048_576.0,
                    file_count: cnt,
                    percentage: 0.0,
                    is_dir: true,
                });
            }
        }
    }

    for item in &mut stats {
        if grand_total > 0 {
            item.percentage = ((item.size_bytes as f64) / (grand_total as f64)) * 100.0;
        }
    }

    stats.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(stats)
}

fn main() {
    let mut sys = System::new_all();
    sys.refresh_all();
    let disks = Disks::new_with_refreshed_list();
    let networks = Networks::new_with_refreshed_list();
    let components = Components::new_with_refreshed_list();

    tauri::Builder::default()
        .manage(AppState {
            sys: Mutex::new(sys),
            disks: Mutex::new(disks),
            networks: Mutex::new(networks),
            components: Mutex::new(components),
        })
        .invoke_handler(tauri::generate_handler![
            get_telemetry,
            run_disk_benchmark,
            scan_subnet,
            analyze_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running OmniRig Tauri application");
}
