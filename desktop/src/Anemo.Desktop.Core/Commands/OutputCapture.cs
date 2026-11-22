using System.Text;

namespace Anemo.Desktop.Core.Commands;

/// <summary>
/// Keeps a command's output: the first 20 000 characters and the last 10 000; what lies
/// between is replaced by a marker saying how much was cut. Thread-safe (the process
/// reports output from its own threads).
/// </summary>
public sealed class OutputCapture
{
    public const int Head = 20_000;
    public const int Tail = 10_000;

    private readonly int _headMax;
    private readonly int _tailMax;
    private readonly StringBuilder _head = new();
    private readonly StringBuilder _rest = new();
    private readonly object _lock = new();
    private long _restTotal;

    public OutputCapture(int headMax = Head, int tailMax = Tail)
    {
        _headMax = headMax;
        _tailMax = tailMax;
    }

    public bool Truncated
    {
        get
        {
            lock (_lock)
            {
                return _restTotal > _tailMax;
            }
        }
    }

    public void Append(string chunk)
    {
        lock (_lock)
        {
            var take = Math.Min(chunk.Length, _headMax - _head.Length);
            if (take > 0)
            {
                _head.Append(chunk, 0, take);
                chunk = chunk[take..];
            }

            if (chunk.Length == 0)
            {
                return;
            }

            _restTotal += chunk.Length;
            _rest.Append(chunk);
            if (_rest.Length > 2 * _tailMax)
            {
                _rest.Remove(0, _rest.Length - _tailMax);
            }
        }
    }

    /// <summary>Process output arrives line by line; this puts the line ends back.</summary>
    public void AppendLine(string line) => Append(line + "\n");

    public override string ToString()
    {
        lock (_lock)
        {
            if (_restTotal <= _tailMax)
            {
                return _head.ToString() + _rest;
            }

            var tail = _rest.ToString(_rest.Length - _tailMax, _tailMax);
            var cut = _restTotal - _tailMax;
            return $"{_head}\n[… {cut} characters cut …]\n{tail}";
        }
    }
}
