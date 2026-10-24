package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Instrumented test, which will execute on an Android device.
 *
 * <p>The template this file came from asserted a hardcoded {@code com.getcapacitor.app}, which was
 * never this app's identity and could only ever fail. It must not be replaced with a different
 * hardcoded string either: the application id is TENANT-DERIVED and written into the shell by
 * {@code scripts/native/sync-native-config.js} from {@code tenants/<id>/manifest.json} (spec 103),
 * so any literal here is a second source of truth that goes stale the moment a tenant ships.
 * Assert instead that the running app's package matches the {@code package_name} resource the sync
 * wrote — a real claim: the shell under test is the one the manifest describes.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void packageMatchesTheSyncedTenantIdentity() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        int resId = appContext.getResources().getIdentifier("package_name", "string", appContext.getPackageName());
        assertTrue("package_name string resource is missing — sync-native-config.js did not run", resId != 0);

        assertEquals(appContext.getString(resId), appContext.getPackageName());
    }
}
