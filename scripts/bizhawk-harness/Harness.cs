// TASDeck headless BizHawk harness. scripts/bizhawk-harness.js fetches BizHawk's NES core sources,
// patches in the hooks this file uses, builds it, and runs one job per process. See
// docs/design/bizhawk-harness.md.
//
// movie  : play a bk2 Input Log (NesHawk: one row per frame; SubNESHawk: one row per FrameAdvance)
//          and record the pads at every latch, the pads of every polled frame, and the screens a
//          replay is compared against.
// replay : serve a record stream the way TASDeck firmware does (strobe, poll or latch mode, start
//          delay, guarded prefix, level after the eighth clock), optionally after an EverDrive-style
//          warm launch, and compare the screens against a movie job's.
//
// Pad bytes use TD2P bit order everywhere: A 0x01, B 0x02, Select 0x04, Start 0x08, Up 0x10,
// Down 0x20, Left 0x40, Right 0x80.

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using BizHawk.Emulation.Common;
using BizHawk.Emulation.Cores.Nintendo.NES;
using BizHawk.Emulation.Cores.Nintendo.SubNESHawk;
using Newtonsoft.Json.Linq;
using NESCore = BizHawk.Emulation.Cores.Nintendo.NES.NES;

sealed class Job
{
	public string Mode;
	public string Rom;
	public string Gamedb;
	public string Firmware;
	public string SyncSettings;
	public string Core = "NesHawk";
	public string Rows;
	public string Records;
	public string Serve = "strobe";
	public int WindowUs = 8000;
	public int StartDelay;
	public int GuardUntil;
	public string Overread = "preadvance";
	public int Ports = 2;
	public int? StartupOffset;
	public bool? IdleSynch;
	public int? CpuPhase;
	public int? DmcTimer;
	public string Ram;
	public int LaunchFrames;
	public int LaunchCycle;
	public int TailFrames = 600;
	public int CheckpointEvery;
	public int CheckpointOffset;
	public int MaxFrames;
	public string Reference;
	public bool WriteReference;
	public string OutDir;
}

sealed class FileProvider : ICoreFileProvider
{
	public byte[] Bios;
#if BIZHAWK_MODERN
	public string GetRetroSaveRAMDirectory(string corePath) => ".";
	public string GetRetroSystemPath(string corePath) => ".";
#else
	public string DllPath() => ".";
	public string GetRetroSaveRAMDirectory(IGameInfo game) => ".";
	public string GetRetroSystemPath(IGameInfo game) => ".";
#endif
	public string GetUserPath(string sysID, bool temp) => ".";
	public byte[] GetFirmware(FirmwareID id, string msg = null) => Bios;
	public byte[] GetFirmwareOrThrow(FirmwareID id, string msg = null) => Bios ?? throw new Exception("missing firmware " + id);
	public (byte[] FW, GameInfo Game) GetFirmwareWithGameInfoOrThrow(FirmwareID id, string msg = null) => (GetFirmwareOrThrow(id, msg), null);
}

// The controller BizHawk reads. The core asks it for buttons when a latch happens (and on every
// read while the strobe is high), so whatever masks it holds at that moment are what the console gets.
sealed class Pads : IController
{
	static readonly string[] Names = { "A", "B", "Select", "Start", "Up", "Down", "Left", "Right" };
	public ControllerDefinition Definition { get; set; }
	public int P1, P2, ResetCycle;
	public bool Power, Reset;
	public IReadOnlyCollection<(string Name, int Strength)> GetHapticsSnapshot() => Array.Empty<(string, int)>();
	public void SetHapticChannelStrength(string name, int strength) { }
	public int AxisValue(string name) => name == "Reset Cycle" ? ResetCycle : 0;
	public bool IsPressed(string button)
	{
		if (button == "Power") return Power;
		if (button == "Reset") return Reset;
		if (button.Length < 4 || button[0] != 'P' || button[2] != ' ') return false;
		int mask = button[1] == '1' ? P1 : button[1] == '2' ? P2 : 0;
		int bit = Array.IndexOf(Names, button.Substring(3));
		return bit >= 0 && (mask & (1 << bit)) != 0;
	}
}

// TASDeck firmware playback (NesTasPlayback.cpp) driven by console CPU cycles instead of micros().
// OnLatchEdge is the latch ISR, Service is the 1 kHz window-expiry service, and LiveA is the level
// the data line carries after the eighth clock.
sealed class TasDeckModel
{
	readonly byte[] _records;
	readonly int _total, _ports, _guard;
	readonly bool _strobe, _latchMode;
	readonly long _window;
	bool _started, _hasLatched, _polled, _preAdvanced, _hold, _complete;
	int _delay, _current;
	long _last;

	public int Served1, Served2, ServedIndex = -1, HighestServed = -1;

	public TasDeckModel(byte[] records, string serve, int windowUs, int startDelay, int guardUntil, int ports)
	{
		_records = records;
		_total = records.Length / 2;
		_ports = ports;
		_strobe = serve == "strobe";
		_latchMode = serve == "latch";
		_window = (long)Math.Round(windowUs * 1.789772727);
		_delay = startDelay;
		_guard = _strobe ? guardUntil : 0;
	}

	public bool Complete => _complete;

	int Mask(int index, int port) =>
		index < 0 || index >= _total || (port == 1 && _ports < 2) ? 0 : _records[2 * index + port];

	bool ExpiryDue(long now)
	{
		if (_complete || (_preAdvanced && !_hold)) return false;
		if (_hasLatched && now - _last < _window) return false;
		if (!_started) return _delay == 0;
		return _strobe ? _hold : _polled;
	}

	public void Service(long now)
	{
		if (!ExpiryDue(now)) return;
		if (!_started)
		{
			_started = true;
			_current = 0;
			_preAdvanced = true;
			return;
		}
		_polled = false;
		if (_hold)
		{
			_hold = false;
			_preAdvanced = false;
		}
		Advance();
		if (!_complete) _preAdvanced = true;
	}

	void Advance()
	{
		if (_current + 1 >= _total)
		{
			_complete = true;
			_current = _total;
		}
		else
		{
			_current++;
		}
	}

	public void OnLatchEdge(long now)
	{
		Service(now);
		if (_strobe)
		{
			bool sameGuardWindow = _started && _current < _guard && _hasLatched && now - _last < _window;
			_hasLatched = true;
			_last = now;
			if (!_started)
			{
				if (_delay > 0) _delay--;
				else
				{
					_started = true;
					_current = 0;
				}
			}
			else if (_preAdvanced) _preAdvanced = false;
			else if (!sameGuardWindow) Advance();
			_hold = _started && !_complete && _current < _guard;
		}
		else
		{
			bool newWindow = !_hasLatched || now - _last >= _window;
			_hasLatched = true;
			_last = now;
			if (newWindow)
			{
				if (_preAdvanced)
				{
					_preAdvanced = false;
					_polled = false;
				}
				else
				{
					bool previousWindowPolled = _polled;
					_polled = false;
					if (!_started)
					{
						if (_delay > 0)
						{
							if (_latchMode || previousWindowPolled) _delay--;
						}
						else
						{
							_started = true;
							_current = 0;
						}
					}
					else if (previousWindowPolled) Advance();
				}
			}
			if (_latchMode) _polled = true;
		}

		bool serving = _started && !_complete;
		Served1 = serving ? Mask(_current, 0) : 0;
		Served2 = serving ? Mask(_current, 1) : 0;
		ServedIndex = serving ? _current : -1;
		if (serving && _current > HighestServed) HighestServed = _current;
	}

	public void NotePollCompleted(int port)
	{
		if (!_strobe && port < _ports) _polled = true;
	}

	// Data-line level after the eighth clock: the A bit of the mask the next strobe will serve.
	public int LiveA(int port, long now)
	{
		if (!_strobe)
		{
			Service(now);
			return _started && !_complete ? Mask(_current, port) & 1 : 0;
		}
		if (!_started) return _delay == 0 ? Mask(0, port) & 1 : 0;
		if (_complete) return 0;
		return (_hold || _preAdvanced ? Mask(_current, port) : Mask(_current + 1, port)) & 1;
	}
}

// Screens are compared at half resolution, RGB, exact pixel match.
static class Screens
{
	public const int W = 128, H = 120, Size = W * H * 3;

	public static byte[] Grab(NESCore nes)
	{
		int[] argb = nes.videoProvider.GetVideoBuffer();
		var s = new byte[Size];
		for (int y = 0; y < H; y++)
		{
			for (int x = 0; x < W; x++)
			{
				int p = argb[(2 * y) * 256 + 2 * x];
				int o = (y * W + x) * 3;
				s[o] = (byte)(p >> 16);
				s[o + 1] = (byte)(p >> 8);
				s[o + 2] = (byte)p;
			}
		}
		return s;
	}

	public static double Similarity(byte[] a, byte[] b)
	{
		int same = 0;
		for (int i = 0; i < Size; i += 3)
		{
			if (a[i] == b[i] && a[i + 1] == b[i + 1] && a[i + 2] == b[i + 2]) same++;
		}
		return same / (double)(W * H);
	}

	public static double Uniformity(byte[] s)
	{
		var counts = new Dictionary<int, int>();
		for (int i = 0; i < Size; i += 3)
		{
			int key = (s[i] << 16) | (s[i + 1] << 8) | s[i + 2];
			counts[key] = counts.TryGetValue(key, out var n) ? n + 1 : 1;
		}
		return counts.Values.Max() / (double)(W * H);
	}

	public static void WritePng(string path, params byte[][] panels)
	{
		int w = W * panels.Length + 4 * (panels.Length - 1);
		var raw = new byte[H * (w * 3 + 1)];
		for (int y = 0; y < H; y++)
		{
			int row = y * (w * 3 + 1);
			for (int p = 0; p < panels.Length; p++)
			{
				Buffer.BlockCopy(panels[p], y * W * 3, raw, row + 1 + p * (W + 4) * 3, W * 3);
			}
		}
		using var file = new MemoryStream();
		using var bw = new BinaryWriter(file);
		bw.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
		var ihdr = new byte[13];
		BigEndian(ihdr, 0, w);
		BigEndian(ihdr, 4, H);
		ihdr[8] = 8;
		ihdr[9] = 2;
		Chunk(bw, "IHDR", ihdr);
		using var z = new MemoryStream();
		using (var zs = new ZLibStream(z, CompressionLevel.Optimal, true)) zs.Write(raw, 0, raw.Length);
		Chunk(bw, "IDAT", z.ToArray());
		Chunk(bw, "IEND", Array.Empty<byte>());
		bw.Flush();
		File.WriteAllBytes(path, file.ToArray());
	}

	static void BigEndian(byte[] b, int o, int v)
	{
		b[o] = (byte)(v >> 24);
		b[o + 1] = (byte)(v >> 16);
		b[o + 2] = (byte)(v >> 8);
		b[o + 3] = (byte)v;
	}

	static void Chunk(BinaryWriter bw, string type, byte[] data)
	{
		var len = new byte[4];
		BigEndian(len, 0, data.Length);
		bw.Write(len);
		var body = Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
		bw.Write(body);
		var crc = new byte[4];
		BigEndian(crc, 0, (int)Crc(body));
		bw.Write(crc);
	}

	static uint Crc(byte[] data)
	{
		uint c = 0xFFFFFFFF;
		foreach (byte b in data)
		{
			c ^= b;
			for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
		}
		return c ^ 0xFFFFFFFF;
	}
}

// Reference screens: one at each checkpoint record, and every frame in a window around each end
// checkpoint (frames after the last record), so a replay whose timing drifts a little still matches.
sealed class Reference
{
	public const int Window = 30;
	public readonly Dictionary<int, byte[]> Checkpoints = new Dictionary<int, byte[]>();
	public readonly Dictionary<int, byte[]> EndFrames = new Dictionary<int, byte[]>();
	public int[] EndOffsets = Array.Empty<int>();

	public static int[] OffsetsFor(int tail) => new[] { Math.Min(60, tail), tail / 2, tail }.Distinct().OrderBy(x => x).ToArray();

	public bool WantsEnd(int offset) => EndOffsets.Any(o => Math.Abs(offset - o) <= Window);

	public void Save(string path)
	{
		using var bw = new BinaryWriter(File.Create(path));
		bw.Write(Encoding.ASCII.GetBytes("TDSR"));
		bw.Write(EndOffsets.Length);
		foreach (int o in EndOffsets) bw.Write(o);
		bw.Write(Checkpoints.Count);
		foreach (var kv in Checkpoints.OrderBy(kv => kv.Key))
		{
			bw.Write(kv.Key);
			bw.Write(kv.Value);
		}
		bw.Write(EndFrames.Count);
		foreach (var kv in EndFrames.OrderBy(kv => kv.Key))
		{
			bw.Write(kv.Key);
			bw.Write(kv.Value);
		}
	}

	public static Reference Load(string path)
	{
		using var br = new BinaryReader(File.OpenRead(path));
		if (Encoding.ASCII.GetString(br.ReadBytes(4)) != "TDSR") throw new Exception("not a reference file: " + path);
		var r = new Reference();
		r.EndOffsets = Enumerable.Range(0, br.ReadInt32()).Select(_ => br.ReadInt32()).ToArray();
		int n = br.ReadInt32();
		for (int i = 0; i < n; i++) r.Checkpoints[br.ReadInt32()] = br.ReadBytes(Screens.Size);
		n = br.ReadInt32();
		for (int i = 0; i < n; i++) r.EndFrames[br.ReadInt32()] = br.ReadBytes(Screens.Size);
		return r;
	}

	// Best match for a screen taken `offset` frames after the last record, and the frame shift that gave it.
	public (double Similarity, int Shift) MatchEnd(int offset, byte[] screen)
	{
		double best = -1;
		int shift = 0;
		for (int d = -Window; d <= Window; d++)
		{
			if (!EndFrames.TryGetValue(offset + d, out var s)) continue;
			double sim = Screens.Similarity(screen, s);
			if (sim > best || (sim == best && Math.Abs(d) < Math.Abs(shift)))
			{
				best = sim;
				shift = d;
			}
		}
		return (best, shift);
	}
}

static class Program
{
	static Job job;
	static NESCore nes;
	static string romHash;
	static int frame;

	static int Main(string[] args)
	{
		if (args.Length != 1)
		{
			Console.Error.WriteLine("usage: harness <job.json>");
			return 2;
		}
		try
		{
			job = JsonSerializer.Deserialize<Job>(File.ReadAllText(args[0]), new JsonSerializerOptions { IncludeFields = true, PropertyNameCaseInsensitive = true });
			Directory.CreateDirectory(job.OutDir);
			var summary = job.Mode == "movie" ? RunMovie() : RunReplay();
			File.WriteAllText(Path.Combine(job.OutDir, "summary.json"), JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true }));
			return 0;
		}
		catch (Exception e)
		{
			Console.Error.WriteLine("harness error: " + e);
			return 1;
		}
	}

	static NESCore.NESSyncSettings LoadSyncSettings()
	{
		var sync = new NESCore.NESSyncSettings();
		sync.Controls.NesLeftPort = "ControllerNES";
		sync.Controls.NesRightPort = "ControllerNES";
		if (job.SyncSettings != null && File.Exists(job.SyncSettings))
		{
			var root = JObject.Parse(File.ReadAllText(job.SyncSettings));
			var o = root["o"] as JObject ?? root;
			foreach (var t in o.DescendantsAndSelf().OfType<JObject>().ToList()) t.Remove("$type");
			Newtonsoft.Json.JsonConvert.PopulateObject(o.ToString(), sync);
		}
		return sync;
	}

	static (SubNESHawk Sub, NESCore Nes) Build(bool sub)
	{
#if BIZHAWK_MODERN
		Database.InitializeDatabase(job.Gamedb, null, true);
#else
		Database.InitializeDatabase(Path.Combine(job.Gamedb, "gamedb.txt"), true);
#endif
		BootGodDb.Initialize(job.Gamedb);
		var rom = File.ReadAllBytes(job.Rom);
		var game = Database.GetGameInfo(rom, Path.GetFileName(job.Rom));
		romHash = game.Hash;
		var files = new FileProvider { Bios = job.Firmware != null ? File.ReadAllBytes(job.Firmware) : null };
		var comm = NewCoreComm(files);
		var sync = LoadSyncSettings();
		if (sub)
		{
			var s = new SubNESHawk(comm, game, rom, new NESCore.NESSettings(), sync);
			return (s, s._nesCore);
		}
		return (null, new NESCore(comm, game, rom, new NESCore.NESSettings(), sync));
	}

	static CoreComm NewCoreComm(ICoreFileProvider files)
	{
#if BIZHAWK_MODERN
		return new CoreComm(s => Console.Error.WriteLine("core: " + s), (s, _) => { }, files, CoreComm.CorePreferencesFlags.None, null);
#else
		return new CoreComm(s => Console.Error.WriteLine("core: " + s), s => { }, files, CoreComm.CorePreferencesFlags.None);
#endif
	}

	static void ApplyPowerOnState()
	{
		if (job.StartupOffset.HasValue) nes.ppu.start_up_offset = job.StartupOffset.Value;
		if (job.IdleSynch.HasValue) nes.ppu.idleSynch = job.IdleSynch.Value;
		if (job.CpuPhase.HasValue) nes.ppu.cpu_stepcounter = job.CpuPhase.Value;
		if (job.DmcTimer.HasValue) nes.apu.dmc.timer = job.DmcTimer.Value;
	}

	static void ApplyRam()
	{
		if (job.Ram == null) return;
		if (job.Ram == "everdrive")
		{
			// The EverDrive N8 loader clears the zero page and leaves 00 00 00 00 FF FF FF FF elsewhere.
			for (int i = 0; i < 0x800; i++) nes.ram[i] = i < 0x100 ? (byte)0 : ((i & 4) != 0 ? (byte)0xFF : (byte)0);
		}
		else if (job.Ram.StartsWith("random:"))
		{
			new Random(int.Parse(job.Ram.Substring(7))).NextBytes(nes.ram);
		}
		else if (job.Ram.StartsWith("fill:"))
		{
			Array.Fill(nes.ram, (byte)int.Parse(job.Ram.Substring(5)));
		}
		else throw new Exception("unknown ram setting " + job.Ram);
	}

	sealed class ReadStats
	{
		public readonly int[] Reads = new int[2];
		public readonly Dictionary<string, int>[] PerLatch = { new Dictionary<string, int>(), new Dictionary<string, int>() };
		public int OverreadLatches, FirstOverreadLatch = -1, Latches;
		public readonly Dictionary<(int Addr, int Pc), int> OddReads = new Dictionary<(int, int), int>();

		public void CloseLatch()
		{
			if (Latches > 0)
			{
				for (int p = 0; p < 2; p++)
				{
					string k = Reads[p] > 8 ? ">8" : Reads[p].ToString();
					PerLatch[p][k] = PerLatch[p].TryGetValue(k, out var n) ? n + 1 : 1;
				}
				if ((Reads[0] > 8 || Reads[1] > 8))
				{
					OverreadLatches++;
					if (FirstOverreadLatch < 0) FirstOverreadLatch = Latches - 1;
				}
			}
			Reads[0] = Reads[1] = 0;
			Latches++;
		}

		// Reads nothing on the cartridge answers: $4018-$401F, $4020-$5FFF unless the board handles
		// expansion reads (FDS, MMC5...), and $6000-$7FFF when the board has no WRAM there.
		public object OddReadList(NESCore nes)
		{
			bool exp = Overrides(nes.Board, "ReadExp");
			bool wram = nes.Board.Wram != null || Overrides(nes.Board, "ReadWram");
			return OddReads
				.Where(kv => kv.Key.Addr < 0x4020 || (kv.Key.Addr < 0x6000 ? !exp : !wram))
				.OrderByDescending(kv => kv.Value)
				.Take(20)
				.Select(kv => new { address = kv.Key.Addr, pc = kv.Key.Pc, count = kv.Value })
				.ToList();
		}

		static bool Overrides(object board, string method)
		{
			var m = board.GetType().GetMethod(method, new[] { typeof(int) });
			return m != null && m.DeclaringType != m.GetBaseDefinition().DeclaringType;
		}
	}

	static void HookOddReads(ReadStats stats)
	{
		NESCore.HookReadOdd = (addr, value) =>
		{
			if (addr < 0x4018) return;
			var key = ((int)addr, (int)nes.cpu.PC);
			stats.OddReads[key] = stats.OddReads.TryGetValue(key, out var n) ? n + 1 : 1;
		};
	}

	static object RunMovie()
	{
		bool subCore = job.Core == "SubNESHawk";
		var (sub, core) = Build(subCore);
		nes = core;
		ApplyPowerOnState();
		ApplyRam();

		var rows = File.ReadAllBytes(job.Rows);
		int rowCount = rows.Length / 7;
		var pads = new Pads { Definition = subCore ? sub.ControllerDefinition : nes.ControllerDefinition };
		var stats = new ReadStats();
		HookOddReads(stats);

		var latches = new List<(int Row, int Frame, int P1, int P2)>();
		var polled = new List<(int Frame, int P1, int P2)>();
		var latchCsv = new StringBuilder("latch,row,frame,scanline,p1,p2,cpu_cycle\n");
		var reference = new Reference { EndOffsets = Reference.OffsetsFor(job.TailFrames) };
		var tail = new List<(int Frame, byte[] Screen)>();
		int strobe = 0, row = 0, lastLatchFrame = -1, latchesThisFrame = 0, multiLatchFrames = 0;
		int? frameMask1 = null, frameMask2 = null;
		int firstMixedFrame = -1, mixedFrames = 0;
		bool lastReset = false, lastPower = false;
		var consolePresses = new List<object>();
		var latchesPerFrame = new Dictionary<int, int>();
		bool inMovie = true;
		// Reads count toward the latch the movie drove: in the movie and, when the movie stops on a
		// latch row, until that frame's next strobe or its end.
		bool countReads = true;

		NESCore.HookJoyReadPre = addr =>
		{
			if (strobe == 0 && countReads) stats.Reads[addr == 0x4016 ? 0 : 1]++;
		};
		NESCore.HookJoyWrite = v =>
		{
			int bit = v & 1;
			if (strobe == 1 && bit == 0 && !inMovie) countReads = false;
			if (strobe == 1 && bit == 0 && inMovie)
			{
				stats.CloseLatch();
				latchesThisFrame++;
				{
					latches.Add((row, frame, pads.P1, pads.P2));
					latchCsv.Append($"{latches.Count - 1},{row},{frame},{nes.ppu.ppur.status.sl},{pads.P1:X2},{pads.P2:X2},{nes.cpu.TotalExecutedCycles}\n");
					lastLatchFrame = frame;
					tail.Clear();
					if (job.CheckpointEvery > 0 && (latches.Count - 1) % job.CheckpointEvery == 0) reference.Checkpoints[latches.Count - 1] = Screens.Grab(nes);
					if (subCore)
					{
						if (frameMask1.HasValue && (frameMask1 != pads.P1 || frameMask2 != pads.P2))
						{
							mixedFrames++;
							if (firstMixedFrame < 0) firstMixedFrame = frame;
						}
						frameMask1 = pads.P1;
						frameMask2 = pads.P2;
					}
				}
			}
			strobe = bit;
		};

		// Counts the movie's part of the current frame: its latches and, for SubNESHawk, its polled pads.
		void CloseMovieFrame()
		{
			if (latchesThisFrame > 1) multiLatchFrames++;
			latchesPerFrame[latchesThisFrame] = latchesPerFrame.TryGetValue(latchesThisFrame, out var n) ? n + 1 : 1;
			if (subCore && frameMask1.HasValue) polled.Add((frame, frameMask1.Value, frameMask2.Value));
			frameMask1 = frameMask2 = null;
			latchesThisFrame = 0;
		}

		void EndFrame()
		{
			if (inMovie) CloseMovieFrame();
			else countReads = false;
			frameMask1 = frameMask2 = null;
			latchesThisFrame = 0;
			frame++;
			if (lastLatchFrame >= 0 && frame - lastLatchFrame <= job.TailFrames + Reference.Window)
			{
				tail.Add((frame - lastLatchFrame, Screens.Grab(nes)));
			}
		}

		void SetRow(int i)
		{
			if (i < rowCount)
			{
				pads.P1 = rows[7 * i];
				pads.P2 = rows[7 * i + 1];
				pads.Power = (rows[7 * i + 2] & 1) != 0;
				pads.Reset = (rows[7 * i + 2] & 2) != 0;
				pads.ResetCycle = BitConverter.ToInt32(rows, 7 * i + 3);
				// A press is the first row of a hold; either button on row 0 is part of starting the movie.
				if (pads.Reset && !lastReset && i > 0) consolePresses.Add(new { button = "Reset", row = i, afterRecord = latches.Count - 1 });
				if (pads.Power && !lastPower && i > 0) consolePresses.Add(new { button = "Power", row = i, afterRecord = latches.Count - 1 });
				lastReset = pads.Reset;
				lastPower = pads.Power;
			}
			else
			{
				pads.P1 = pads.P2 = pads.ResetCycle = 0;
				pads.Power = pads.Reset = false;
			}
		}

		int movieFrames = 0;
		int limit = rowCount + 2_000_000;
		bool midFrame = false;
		for (row = 0; row < limit; row++)
		{
			inMovie = row < rowCount;
			if (row == rowCount)
			{
				// A SubNESHawk row can end on a latch, so the movie can stop partway through a frame.
				// That frame's latches and pads are still the movie's, and so is the frame.
				if (midFrame) CloseMovieFrame();
				movieFrames = midFrame ? frame + 1 : frame;
				countReads = midFrame;
			}
			if (!inMovie && (lastLatchFrame < 0 || frame - lastLatchFrame > job.TailFrames + Reference.Window)) break;
			SetRow(row);
			if (subCore)
			{
				sub.FrameAdvance(pads, true, false);
				midFrame = !sub.pass_a_frame;
				if (sub.pass_a_frame) EndFrame();
			}
			else
			{
				nes.FrameAdvance(pads, true, false);
				if (inMovie && !nes.IsLagFrame) polled.Add((frame, pads.P1, pads.P2));
				EndFrame();
			}
		}
		stats.CloseLatch();

		foreach (var (offset, screen) in tail)
		{
			if (reference.WantsEnd(offset)) reference.EndFrames[offset] = screen;
		}
		reference.Save(Path.Combine(job.OutDir, "reference.bin"));
		File.WriteAllBytes(Path.Combine(job.OutDir, "latches.bin"), latches.SelectMany(l => new[] { (byte)l.P1, (byte)l.P2 }).ToArray());
		using (var bw = new BinaryWriter(File.Create(Path.Combine(job.OutDir, "frames.bin"))))
		{
			foreach (var (f, p1, p2) in polled)
			{
				bw.Write(f);
				bw.Write((byte)p1);
				bw.Write((byte)p2);
			}
		}
		File.WriteAllText(Path.Combine(job.OutDir, "latches.csv"), latchCsv.ToString());
		byte[] endScreen = reference.EndFrames.TryGetValue(job.TailFrames, out var es) ? es : Screens.Grab(nes);
		Screens.WritePng(Path.Combine(job.OutDir, "end.png"), endScreen);

		return new
		{
			mode = "movie",
			core = job.Core,
			board = nes.BoardName,
			romHash,
			hasWram = nes.Board.Wram != null,
			rows = rowCount,
			movieFrames,
			latches = latches.Count,
			polledFrames = polled.Count,
			lastLatchFrame,
			multiLatchFrames,
			latchesPerFrame = latchesPerFrame.OrderBy(kv => kv.Key).ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
			readsPerLatch = new { port1 = stats.PerLatch[0], port2 = stats.PerLatch[1] },
			overreadLatches = stats.OverreadLatches,
			firstOverreadLatch = stats.FirstOverreadLatch,
			port2Used = latches.Any(l => l.P2 != 0),
			perLatchInputWithinFrame = mixedFrames,
			firstPerLatchInputFrame = firstMixedFrame,
			consolePresses,
			oddReads = stats.OddReadList(nes),
			endUniformity = Screens.Uniformity(endScreen),
			endOffsets = reference.EndOffsets,
			checkpointEvery = job.CheckpointEvery,
		};
	}

	static object RunReplay()
	{
		var (sub, core) = Build(true);
		nes = core;
		ApplyPowerOnState();

		var records = File.ReadAllBytes(job.Records);
		int total = records.Length / 2;
		var model = new TasDeckModel(records, job.Serve, job.WindowUs, job.StartDelay, job.GuardUntil, job.Ports);
		var pads = new Pads { Definition = sub.ControllerDefinition };
		var stats = new ReadStats();
		HookOddReads(stats);
		var reference = job.Reference != null ? Reference.Load(job.Reference) : null;
		var writeRef = job.WriteReference ? new Reference { EndOffsets = Reference.OffsetsFor(job.TailFrames) } : null;
		var tail = new List<(int Frame, byte[] Screen)>();

		bool armed = job.LaunchFrames == 0;
		int strobe = 0, latches = 0, lastRecordFrame = -1;
		var checkpoints = new List<(int Record, int Frame, double Similarity, byte[] Reference, byte[] Screen)>();
		int bareLatches = 0;
		string overread = job.Overread;

		NESCore.HookJoyReadPre = addr =>
		{
			if (strobe != 0) return;
			int p = addr == 0x4016 ? 0 : 1;
			stats.Reads[p]++;
			if (armed && stats.Reads[p] == 8) model.NotePollCompleted(p);
		};
		ControllerNES.OverreadLevel = port =>
		{
			if (!armed) return 1;
			if (job.Serve == "strobe")
			{
				if (overread == "pressed") return 1;
				if (overread == "released") return 0;
			}
			return model.LiveA(port, nes.cpu.TotalExecutedCycles);
		};
		NESCore.HookJoyWrite = v =>
		{
			int bit = v & 1;
			if (armed && strobe == 0 && bit == 1)
			{
				if (latches > 0 && stats.Reads[0] == 0 && stats.Reads[1] == 0) bareLatches++;
				stats.CloseLatch();
				int before = model.HighestServed;
				model.OnLatchEdge(nes.cpu.TotalExecutedCycles);
				pads.P1 = model.Served1;
				pads.P2 = model.Served2;
				latches++;
				if (model.HighestServed > before)
				{
					int k = model.HighestServed;
					// The file's record number, the one Skip first and the reports use.
					int key = k + job.CheckpointOffset;
					if (k == total - 1) lastRecordFrame = frame;
					if (job.CheckpointEvery > 0 && key % job.CheckpointEvery == 0)
					{
						var screen = Screens.Grab(nes);
						if (writeRef != null) writeRef.Checkpoints[key] = screen;
						if (reference != null && reference.Checkpoints.TryGetValue(key, out var refScreen))
						{
							checkpoints.Add((key, frame, Screens.Similarity(screen, refScreen), refScreen, screen));
						}
					}
				}
			}
			strobe = bit;
		};

		// EverDrive-style launch: run the game from power-on, then reset into it at a chosen CPU cycle
		// without resetting the PPU (the menu jumps to the reset vector with the PPU running).
		if (job.LaunchFrames > 0)
		{
			SubNESHawk.SkipPpuReset = true;
			bool launched = false;
			SubNESHawk.AfterSoftReset = () =>
			{
				launched = true;
				ApplyRam();
			};
			while (!launched)
			{
				pads.Reset = frame >= job.LaunchFrames;
				pads.ResetCycle = job.LaunchCycle;
				sub.FrameAdvance(pads, true, false);
				if (sub.pass_a_frame) frame++;
				if (frame > job.LaunchFrames + 3) throw new Exception("launch reset never fired");
			}
			pads.Reset = false;
			pads.ResetCycle = 0;
			frame = 0;
			armed = true;
			strobe = 0;
			stats.Reads[0] = stats.Reads[1] = 0;
		}
		else
		{
			ApplyRam();
		}

		int maxFrames = job.MaxFrames > 0 ? job.MaxFrames : 1_000_000;
		while (true)
		{
			sub.FrameAdvance(pads, true, false);
			if (!sub.pass_a_frame) continue;
			frame++;
			if (lastRecordFrame >= 0)
			{
				int offset = frame - lastRecordFrame;
				if (offset <= job.TailFrames + Reference.Window) tail.Add((offset, Screens.Grab(nes)));
				if (offset >= job.TailFrames + (writeRef != null ? Reference.Window : 0)) break;
			}
			else if (frame >= maxFrames) break;
		}
		stats.CloseLatch();

		var ends = new List<object>();
		double worst = lastRecordFrame >= 0 ? 1 : 0;
		byte[] endScreen = Screens.Grab(nes);
		foreach (var (offset, screen) in tail)
		{
			if (offset == job.TailFrames) endScreen = screen;
			if (reference == null || !reference.EndOffsets.Contains(offset)) continue;
			var (sim, shift) = reference.MatchEnd(offset, screen);
			ends.Add(new { framesAfterLastRecord = offset, similarity = Math.Round(sim, 4), shift });
			worst = Math.Min(worst, sim);
		}
		Screens.WritePng(Path.Combine(job.OutDir, "end.png"), endScreen);

		// Where the run left the movie for good: the first checkpoint after which none matches again.
		// Earlier mismatches that recover (leftover screens after an EverDrive launch) don't count.
		object divergence = null;
		int parted = checkpoints.Count;
		while (parted > 0 && checkpoints[parted - 1].Similarity < 0.8) parted--;
		if (parted < checkpoints.Count)
		{
			var c = checkpoints[parted];
			divergence = new { record = c.Record, frame = c.Frame, similarity = Math.Round(c.Similarity, 4) };
			Screens.WritePng(Path.Combine(job.OutDir, "divergence.png"), c.Reference, c.Screen);
		}
		if (writeRef != null)
		{
			foreach (var (offset, screen) in tail)
			{
				if (writeRef.WantsEnd(offset)) writeRef.EndFrames[offset] = screen;
			}
			writeRef.Save(Path.Combine(job.OutDir, "reference.bin"));
		}

		return new
		{
			mode = "replay",
			records = total,
			recordsServed = model.HighestServed + 1,
			allRecordsServed = lastRecordFrame >= 0,
			lastRecordFrame,
			frames = frame,
			latches,
			bareLatches,
			overreadLatches = stats.OverreadLatches,
			firstOverreadLatch = stats.FirstOverreadLatch,
			oddReads = stats.OddReadList(nes),
			checkpoints = checkpoints.Select(c => new { record = c.Record, frame = c.Frame, similarity = Math.Round(c.Similarity, 4) }).ToList(),
			divergence,
			end = ends,
			endSimilarity = reference != null ? Math.Round(worst, 4) : (double?)null,
			endUniformity = Screens.Uniformity(endScreen),
		};
	}
}
