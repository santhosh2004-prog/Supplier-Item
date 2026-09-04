sap.ui.define(
  ["supplieropenitems/controller/Main.controller"],
  function (MainController) {
    "use strict";

    /**
     * Controller for the routed master-detail page (Detail.view.xml,
     * "Routedetail") â€” everything that used to be Main.view.xml's
     * masterDetailCard block (visible="{recon>/masterDetailMode}") now lives
     * on its own page, reached via router.navTo from Main.controller.js's
     * onSearch whenever a Supplier is entered alongside Company Code/dates.
     *
     * Extending MainController (not sap.ui.core.mvc.Controller directly)
     * means every fragment press handler (onOpeningBalancePress,
     * onTransactionsPress, ... all ~17 module panels), every _load* OData
     * call, every formatter, and _loadSidebarTotals are inherited unchanged
     * â€” Detail.view.xml includes the exact same fragments Main.view.xml's
     * masterDetailCard used to, so those handlers' `this.byId(...)` calls
     * resolve against Detail's own view (same control ids, via the shared
     * FilterBar fragment + the fragments themselves) exactly the way they
     * used to resolve against Main's. Only onInit is overridden here â€” to
     * load from the route's params instead of the plain dashboard search.
     */
    return MainController.extend("supplieropenitems.controller.Detail", {
      onInit: function () {
        // Same model/column-map/saved-layout setup as Main.controller.js's
        // onInit (see _initCommon there) â€” just without the trailing
        // onSearch() call, since this page is driven by route params
        // instead of a plain Go press on load.
        this._initCommon();

        this.getOwnerComponent()
          .getRouter()
          .getRoute("Routedetail")
          .attachPatternMatched(this._onRouteMatched, this);
      },

      /**
       * Fired every time router.navTo("Routedetail", {...}) lands here â€”
       * both the initial navigation from Main's onSearch, and a later Go
       * press on THIS page's own filter bar (onSearch is inherited
       * unchanged and re-navigates with whatever new dates were entered,
       * which re-fires this same event with the updated params).
       */
      _onRouteMatched: function (oEvent) {
        var oArgs = oEvent.getParameter("arguments");
        var sBukrs = decodeURIComponent(oArgs.bukrs || "");
        var sLifnr = decodeURIComponent(oArgs.lifnr || "");
        var sFromDate = decodeURIComponent(oArgs.fromdate || "");
        var sToDate = decodeURIComponent(oArgs.todate || "");

        if (!sBukrs || !sLifnr || !sFromDate) {
          // Missing/malformed params (e.g. a hand-typed URL) â€” nothing
          // sensible to load, bounce back to the dashboard instead of
          // showing a half-populated page.
          this.getOwnerComponent().getRouter().navTo("Routemain");
          return;
        }

        this.byId("inputBukrs").setValue(sBukrs);
        this.byId("inputLifnr").setValue(sLifnr);
        this.byId("inputKeyDate").setValue(sFromDate);
        this.byId("inputKeyDateTo").setValue(sToDate || sFromDate);

        this._sBukrs = sBukrs;
        this._sKeyDate = sFromDate;
        this._sKeyDateTo = sToDate || null;
        this._sSelectedAkont = null;
        // First-ever arrival on this page this session defaults to Opening
        // Balance, same as a fresh Main page load â€” _loadSupplierMasterDetail
        // and _loadSidebarTotals below still reload whichever panel a
        // restored/prior session had open (see _sActiveMdPanel usage in
        // Main.controller.js).
        this._sActiveMdPanel = this._sActiveMdPanel || "opening";
        this._sActiveMdPanelLabel = this._sActiveMdPanelLabel || "";
        this._persistUiState();

        // Inherited from MainController, unchanged â€” fires OpBalAsOnSet,
        // re-opens whichever panel was active, and calls _loadSidebarTotals.
        this._loadSupplierMasterDetail(sBukrs, sLifnr, sFromDate, sToDate);
      },
    });
  },
);
