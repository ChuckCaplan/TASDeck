// Stand-ins for the parts of BizHawk the harness does not build: core registration attributes and
// the reflection cache from BizHawk.Emulation.Cores, the generated version constants, and the
// BlipBuffer wrapper around the native blip_buf library (audio is not needed).

using System;

namespace BizHawk.Emulation.Cores
{
	public enum CorePriority { UserPreference = -200, Low = 10, SuperLow = 20, Normal = 0, High = -100, GameDbPreference = -300 }

	[AttributeUsage(AttributeTargets.Constructor, AllowMultiple = true)]
	public sealed class CoreConstructorAttribute : Attribute
	{
		public CoreConstructorAttribute(string system) { }
		public CoreConstructorAttribute(string[] systems) { }
		public CorePriority Priority { get; set; }
	}

	public static class ReflectionCache
	{
		public static readonly Type[] Types = typeof(ReflectionCache).Assembly.GetTypes();
	}
}

namespace BizHawk.Common
{
	public static partial class VersionInfo
	{
		public const string GIT_BRANCH = "tasdeck-harness";
		public const string GIT_SHORTHASH = "harness";
		public const string GIT_REV = "0";
#if BIZHAWK_MODERN
		public const string GIT_HASH = "harness";
#endif
	}
}

namespace BizHawk.Emulation.Common
{
	public sealed class BlipBuffer : IDisposable
	{
		public BlipBuffer(int sampleCount) { }
		public const int MaxRatio = 1 << 20;
		public const int MaxFrame = 4000;
		public void Dispose() { }
		public void SetRates(double clockRate, double sampleRate) { }
		public void Clear() { }
		public void AddDelta(uint clockTime, int delta) { }
		public void AddDeltaFast(uint clockTime, int delta) { }
		public int ClocksNeeded(int sampleCount) => 0;
		public void EndFrame(uint clockDuration) { }
		public int SamplesAvailable() => 0;
		public int ReadSamples(short[] output, int count, bool stereo) => 0;
		public int ReadSamplesLeft(short[] output, int count) => 0;
		public int ReadSamplesRight(short[] output, int count) => 0;
	}
}
