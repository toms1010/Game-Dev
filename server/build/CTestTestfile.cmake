# CMake generated Testfile for 
# Source directory: /home/tommyp/Desktop/Game Dev/server
# Build directory: /home/tommyp/Desktop/Game Dev/server/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test([=[test_game]=] "/home/tommyp/Desktop/Game Dev/server/build/test_game")
set_tests_properties([=[test_game]=] PROPERTIES  TIMEOUT "60" _BACKTRACE_TRIPLES "/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;157;add_test;/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;0;")
add_test([=[test_network]=] "/home/tommyp/Desktop/Game Dev/server/build/test_network")
set_tests_properties([=[test_network]=] PROPERTIES  TIMEOUT "60" _BACKTRACE_TRIPLES "/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;157;add_test;/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;0;")
add_test([=[test_security]=] "/home/tommyp/Desktop/Game Dev/server/build/test_security")
set_tests_properties([=[test_security]=] PROPERTIES  TIMEOUT "60" _BACKTRACE_TRIPLES "/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;157;add_test;/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;0;")
add_test([=[test_performance]=] "/home/tommyp/Desktop/Game Dev/server/build/test_performance")
set_tests_properties([=[test_performance]=] PROPERTIES  RUN_SERIAL "TRUE" TIMEOUT "120" _BACKTRACE_TRIPLES "/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;157;add_test;/home/tommyp/Desktop/Game Dev/server/CMakeLists.txt;0;")
