# Flutter Integration Guide

This guide explains how to integrate the Private Logger into your Flutter mobile application.

## API Endpoint

```
https://private-logger-api.christian-yaranga-05.workers.dev
```

## Log Viewer

View your logs at: https://chrisyaranga.dev/logger/

---

## 1. Create the Logger Service

Create a new file `lib/services/remote_logger.dart`:

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

enum LogEnvironment { dev, test, prod }

class RemoteLogger {
  static const String _baseUrl =
      'https://private-logger-api.christian-yaranga-05.workers.dev';

  final String userId;
  final LogEnvironment environment;

  RemoteLogger({
    required this.userId,
    this.environment = LogEnvironment.dev,
  });

  /// Sends a log entry to the remote server
  Future<bool> log(
    String message, {
    Map<String, dynamic>? metadata,
    LogEnvironment? overrideEnvironment,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$_baseUrl/logs'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'user_id': userId,
          'message': message,
          'metadata': metadata,
          'environment': (overrideEnvironment ?? environment).name,
        }),
      );

      return response.statusCode == 201;
    } catch (e) {
      // Silently fail - don't crash the app for logging errors
      debugPrint('RemoteLogger error: $e');
      return false;
    }
  }

  /// Log an info message
  Future<bool> info(String message, {Map<String, dynamic>? metadata}) {
    return log(message, metadata: {...?metadata, 'level': 'info'});
  }

  /// Log a warning message
  Future<bool> warning(String message, {Map<String, dynamic>? metadata}) {
    return log(message, metadata: {...?metadata, 'level': 'warning'});
  }

  /// Log an error message
  Future<bool> error(
    String message, {
    Object? error,
    StackTrace? stackTrace,
    Map<String, dynamic>? metadata,
  }) {
    return log(message, metadata: {
      ...?metadata,
      'level': 'error',
      if (error != null) 'error': error.toString(),
      if (stackTrace != null) 'stackTrace': stackTrace.toString(),
    });
  }

  /// Log a debug message (only in dev environment)
  Future<bool> debug(String message, {Map<String, dynamic>? metadata}) {
    if (environment != LogEnvironment.dev) return Future.value(false);
    return log(message, metadata: {...?metadata, 'level': 'debug'});
  }
}
```

## 2. Add the HTTP Dependency

Add to your `pubspec.yaml`:

```yaml
dependencies:
  http: ^1.2.0
```

Then run:

```bash
flutter pub get
```

## 3. Initialize the Logger

In your `main.dart` or a dependency injection setup:

```dart
import 'package:flutter/foundation.dart';
import 'services/remote_logger.dart';

// Create a global logger instance
late final RemoteLogger logger;

void main() {
  // Initialize with user ID and environment
  logger = RemoteLogger(
    userId: 'user-${DateTime.now().millisecondsSinceEpoch}', // Or actual user ID
    environment: kDebugMode ? LogEnvironment.dev : LogEnvironment.prod,
  );

  runApp(MyApp());
}
```

## 4. Usage Examples

### Basic Logging

```dart
// Simple log
await logger.log('User opened the app');

// Log with metadata
await logger.log('User viewed product', metadata: {
  'product_id': 'prod-123',
  'product_name': 'Premium Widget',
  'category': 'electronics',
});
```

### Log Levels

```dart
// Info level
await logger.info('User completed onboarding');

// Warning level
await logger.warning('API response slow', metadata: {
  'endpoint': '/api/products',
  'duration_ms': 3500,
});

// Error level
try {
  await someRiskyOperation();
} catch (e, stackTrace) {
  await logger.error(
    'Failed to process payment',
    error: e,
    stackTrace: stackTrace,
    metadata: {'order_id': 'order-456'},
  );
}

// Debug level (only logs in dev environment)
await logger.debug('Cache hit for key: user_prefs');
```

### Screen Tracking

```dart
class MyScreen extends StatefulWidget {
  @override
  _MyScreenState createState() => _MyScreenState();
}

class _MyScreenState extends State<MyScreen> {
  @override
  void initState() {
    super.initState();
    logger.info('Screen viewed', metadata: {
      'screen': 'MyScreen',
      'timestamp': DateTime.now().toIso8601String(),
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(...);
  }
}
```

### User Actions

```dart
ElevatedButton(
  onPressed: () async {
    await logger.log('Button pressed', metadata: {
      'button': 'submit_order',
      'screen': 'CheckoutScreen',
    });
    // ... handle button press
  },
  child: Text('Submit Order'),
)
```

### API Call Logging

```dart
Future<void> fetchProducts() async {
  final stopwatch = Stopwatch()..start();

  try {
    final response = await http.get(Uri.parse('$apiUrl/products'));
    stopwatch.stop();

    await logger.info('API call completed', metadata: {
      'endpoint': '/products',
      'status_code': response.statusCode,
      'duration_ms': stopwatch.elapsedMilliseconds,
    });
  } catch (e, stackTrace) {
    stopwatch.stop();
    await logger.error('API call failed',
      error: e,
      stackTrace: stackTrace,
      metadata: {
        'endpoint': '/products',
        'duration_ms': stopwatch.elapsedMilliseconds,
      },
    );
  }
}
```

## 5. Advanced: Logger with Provider

For better dependency injection, use Provider:

```dart
// In your providers setup
Provider<RemoteLogger>(
  create: (_) => RemoteLogger(
    userId: authService.currentUser?.id ?? 'anonymous',
    environment: kDebugMode ? LogEnvironment.dev : LogEnvironment.prod,
  ),
),

// In your widgets
final logger = context.read<RemoteLogger>();
await logger.log('Something happened');
```

## 6. Advanced: Update User ID After Login

```dart
class AuthService {
  RemoteLogger? _logger;

  void setLogger(RemoteLogger logger) {
    _logger = logger;
  }

  Future<void> login(String email, String password) async {
    final user = await _performLogin(email, password);

    // Create new logger with actual user ID
    _logger = RemoteLogger(
      userId: user.id,
      environment: kDebugMode ? LogEnvironment.dev : LogEnvironment.prod,
    );

    await _logger?.info('User logged in', metadata: {
      'email': email,
      'login_method': 'email',
    });
  }
}
```

## 7. Log Entry Structure

Each log entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `user_id` | String | Unique identifier for the user |
| `message` | String | The log message |
| `metadata` | JSON | Additional structured data |
| `environment` | String | `dev`, `test`, or `prod` |
| `created_at` | DateTime | Auto-generated timestamp |

## 8. Best Practices

1. **Don't log sensitive data** - Avoid logging passwords, tokens, or PII
2. **Use meaningful messages** - Make logs searchable and understandable
3. **Include context** - Add relevant metadata for debugging
4. **Use appropriate environments** - Set `prod` for release builds
5. **Fire and forget** - Don't await logs in critical paths if not necessary

```dart
// Fire and forget (non-blocking)
logger.log('Non-critical event');

// Await when you need confirmation
final success = await logger.error('Critical error occurred');
if (!success) {
  // Handle logging failure if needed
}
```

## 9. Testing

For testing, you can create a mock logger:

```dart
class MockRemoteLogger extends RemoteLogger {
  final List<Map<String, dynamic>> logs = [];

  MockRemoteLogger() : super(userId: 'test-user', environment: LogEnvironment.test);

  @override
  Future<bool> log(String message, {Map<String, dynamic>? metadata, LogEnvironment? overrideEnvironment}) async {
    logs.add({'message': message, 'metadata': metadata});
    return true;
  }
}
```

## API Reference

### POST /logs

Create a new log entry.

**Request:**
```json
{
  "user_id": "user-123",
  "message": "User logged in",
  "metadata": {
    "device": "iPhone 15",
    "os_version": "17.2"
  },
  "environment": "dev"
}
```

**Response (201):**
```json
{
  "success": true,
  "log": {
    "id": 1,
    "user_id": "user-123",
    "message": "User logged in",
    "metadata": "{\"device\":\"iPhone 15\",\"os_version\":\"17.2\"}",
    "environment": "dev",
    "created_at": "2026-01-16 13:37:18"
  }
}
```
