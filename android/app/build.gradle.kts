plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "app.anemo.voice"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.anemo.voice"
        minSdk = 29
        targetSdk = 35
        versionCode = 3
        versionName = "1.1.1"
        // ONNX Runtime's native libraries are large: only the ABIs of real phones.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    // The release key, only when ANEMO_VOICE_KEYSTORE names a keystore (the release
    // workflow sets it; see README "Cut a release"). Without it a release build is
    // unsigned and the debug build is unchanged.
    val releaseKeystore = providers.environmentVariable("ANEMO_VOICE_KEYSTORE").orNull
    signingConfigs {
        if (!releaseKeystore.isNullOrEmpty()) {
            create("release") {
                val storePass = providers.environmentVariable("ANEMO_VOICE_KEYSTORE_PASSWORD").get()
                storeFile = file(releaseKeystore)
                storePassword = storePass
                keyAlias = providers.environmentVariable("ANEMO_VOICE_KEY_ALIAS").get()
                // A PKCS12 keystore (keytool's default) has one password for both.
                keyPassword = providers.environmentVariable("ANEMO_VOICE_KEY_PASSWORD").orNull
                    ?.takeIf { it.isNotEmpty() } ?: storePass
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
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
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.room:room-runtime:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")
    implementation("com.squareup.okhttp3:okhttp:$okhttpVersion")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:$onnxVersion")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:$okhttpVersion")
    // Real org.json on the JVM (android.jar only has stubs).
    testImplementation("org.json:json:20240303")
    // Runs the history DAO's SQL on SQLite on the JVM.
    testImplementation("org.xerial:sqlite-jdbc:3.46.1.3")
    // The desktop ONNX Runtime has the same Java API as the Android one and runs the
    // bundled models on the JVM; the Android artefact is taken off the test classpath below.
    testRuntimeOnly("com.microsoft.onnxruntime:onnxruntime:$onnxVersion")
}

configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}
