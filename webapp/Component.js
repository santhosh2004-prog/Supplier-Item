/**
 * eslint-disable @sap/ui5-jsdocs/no-jsdoc
 */

sap.ui.define([
        "sap/ui/core/UIComponent",
        "sap/ui/Device",
        "supplieropenitems/model/models"
    ],
    function (UIComponent, Device, models) {
        "use strict";

        return UIComponent.extend("supplieropenitems.Component", {
            metadata: {
                manifest: "json"
            },

            /**
             * The component is initialized by UI5 automatically during the startup of the app and calls the init method once.
             * @public
             * @override
             */
            init: function () {
                // call the base component's init function
                UIComponent.prototype.init.apply(this, arguments);

                // enable routing
                this.getRouter().initialize();

                // set the device model
                this.setModel(models.createDeviceModel(), "device");

                // Content density: cozy (bigger, touch-friendly tap targets) on
                // tablets/phones, compact (denser, mouse-optimized) on desktop.
                // index.html no longer hardcodes sapUiSizeCompact so this is
                // the only place density gets decided — keeps the app usable
                // with a finger, not just a mouse pointer.
                document.body.classList.add(
                    Device.support.touch ? "sapUiSizeCozy" : "sapUiSizeCompact",
                );
            }
        });
    }
);