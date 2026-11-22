plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "app.anemo.voice"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.anemo.voice"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // ONNX models are already compressed; keep them uncompressed so they can be read fast.
    androidResources {
        noCompress += "onnx"
    }

    testOptions {
        unitTests.all {
            it.useJUnit()
            // A folder with the openWakeWord models, for OnnxModelsTest (optional).
            it.systemProperty("anemo.models", System.getenv("OWW_MODELS") ?: "")
        }
    }

    lint {
        abortOnError = false
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

val onnxVersion = "1.20.0"
val roomVersion = "2.6.1"
val okhttpVersion = "4.12.0"

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.room:room-runtime:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")
    implementation("com.squareup.okhttp3:okhttp:$okhttpVersion")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:$onnxVersion")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:$okhttpVersion")
    // Real org.json on the JVM (android.jar only has stubs).
    testImplementation("org.json:json:20240303")
    // The desktop ONNX Runtime has the same Java API as the Android one and runs the
    // bundled models on the JVM; the Android artefact is taken off the test classpath below.
    testRuntimeOnly("com.microsoft.onnxruntime:onnxruntime:$onnxVersion")
}

configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}
